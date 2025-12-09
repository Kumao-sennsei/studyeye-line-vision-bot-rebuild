// ================================================
// StudyEye くまお先生ボット - 完全安定版 index.js
// LINE Messaging API / OpenAI / Railway / ESM対応
// ================================================

import express from "express";
import line from "@line/bot-sdk";
import fetch from "node-fetch";

// -----------------------------------------------
// LINE Bot 設定
// -----------------------------------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error("❌ CHANNEL_ACCESS_TOKEN または CHANNEL_SECRET が設定されていません");
}

const client = new line.Client(config);

// -----------------------------------------------
// Express 初期化
// express.json() は絶対に middleware より後に置く！
// -----------------------------------------------
const app = express();

// -----------------------------------------------
// グローバル state
// -----------------------------------------------
const globalState = {};

function getUserState(userId) {
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null,
      waitingAnswer: null,
    };
  }
  return globalState[userId];
}

// -----------------------------------------------
// 数式整形
// -----------------------------------------------
function sanitizeMath(text) {
  if (!text) return "";

  let t = text;
  t = t.replace(/[#$*_`>]/g, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  t = t.replace(/×/g, " x ");
  t = t.replace(/÷/g, " / ");
  t = t.replace(/\u3000/g, " ");
  return t.trim();
}

// -----------------------------------------------
// OpenAI 共通設定
// -----------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TEXT_MODEL_MAIN = "gpt-4o";
const TEXT_MODEL_LIGHT = "gpt-4o-mini";
const VISION_MODEL = "gpt-4.1";

// モデル選択（超軽量判定）
function chooseTextModel(text) {
  return text.length < 40 ? TEXT_MODEL_LIGHT : TEXT_MODEL_MAIN;
}

// -----------------------------------------------
// OpenAI Chat
// -----------------------------------------------
async function callOpenAIChat({ model, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    console.error(await res.text());
    throw new Error("OpenAI Chat error");
  }

  const data = await res.json();
  return sanitizeMath(data.choices?.[0]?.message?.content || "");
}

// -----------------------------------------------
// OpenAI Vision
// -----------------------------------------------
async function callOpenAIVision({ imageBase64, instructions }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "system",
          content:
            "あなたは数学・物理・化学の問題を優しく解説するくまお先生です。Markdown禁止。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    console.error(await res.text());
    throw new Error("Vision error");
  }

  const data = await res.json();
  return sanitizeMath(data.choices?.[0]?.message?.content || "");
}

// -----------------------------------------------
// 画像のバイナリ取得
// -----------------------------------------------
async function getImageBase64(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];

  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("base64"));
    });
    stream.on("error", reject);
  });
}

// -----------------------------------------------
// FREEモード
// -----------------------------------------------
async function handleFreeText(event, state) {
  const text = event.message.text.trim();
  const model = chooseTextModel(text);

  const system =
    "あなたは優しいくまお先生。板書風にていねいに説明。Markdown禁止。「計算機を使います」禁止。";

  const userPrompt =
    "【生徒の質問】\n" +
    text +
    "\n\n【ルール】\n" +
    "・最初に一声かける（例：ここから一緒にやってみようか🐻）\n" +
    "・板書のように丁寧に解説\n" +
    "・最後に軽く励ます";

  const answer = await callOpenAIChat({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  });

  state.lastTopic = text;
  state.lastAnswer = answer;

  return client.replyMessage(event.replyToken, { type: "text", text: answer });
}

// -----------------------------------------------
// 画像（答えの有無確認）
// -----------------------------------------------
async function handleImageFirst(event, state) {
  const base64 = await getImageBase64(event.message.id);

  state.waitingAnswer = {
    kind: "image",
    imageBase64: base64,
    status: "waiting_student_answer",
  };

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "この問題、もし自分の答えがあれば送ってね🐻✨\n" +
      "・答えを送る → 採点＆解説\n" +
      "・なければ「そのまま解説して」と言ってね！",
  });
}

// -----------------------------------------------
// 画像（答え付き）
// -----------------------------------------------
async function handleImageWithStudentAnswer(event, state, studentAnswer) {
  const base64 = state.waitingAnswer.imageBase64;

  const instructions =
    "画像の問題文をきれいに書き起こし、板書のように丁寧に解説し、最後に「答え：○○」を1行でまとめてください。\n" +
    "以下は生徒の答えです。\n\n" +
    studentAnswer +
    "\n\n「正解・惜しい・不正解」も必ず判定。";

  const result = await callOpenAIVision({ imageBase64: base64, instructions });

  state.waitingAnswer = null;

  return client.replyMessage(event.replyToken, { type: "text", text: result });
}

// -----------------------------------------------
// 画像（答えなし → 解説だけ）
// -----------------------------------------------
async function handleImageExplainOnly(event, state) {
  const base64 = state.waitingAnswer.imageBase64;

  const instructions =
    "画像の問題文をきれいに書き起こし、板書のように丁寧に解説し、最後に答えを1行でまとめてください。\n" +
    "生徒の答えはありません。";

  const result = await callOpenAIVision({ imageBase64: base64, instructions });

  state.waitingAnswer = null;

  return client.replyMessage(event.replyToken, { type: "text", text: result });
}

// -----------------------------------------------
// メニュー
// -----------------------------------------------
function replyMenu(token) {
  return client.replyMessage(token, {
    type: "text",
    text:
      "🐻📘 くまお先生メニュー\n\n" +
      "・普通に質問 → そのまま送ってね\n" +
      "・問題の写真 → カメラで送ってね\n" +
      "・答えがあるなら送ってくれると精度UP！",
  });
}

// -----------------------------------------------
// LINE Webhook (署名検証 OK)
// middleware より上に express.json() を絶対置かないこと！
// -----------------------------------------------
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end();

  const events = req.body.events;
  if (!events) return;

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error("Event error:", e);
    }
  }
});

// -----------------------------------------------
// express.json() は Webhook より後ろに置く！
// -----------------------------------------------
app.use(express.json());

// -----------------------------------------------
// イベント振り分け
// -----------------------------------------------
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  const state = getUserState(userId);

  // 画像
  if (event.message.type === "image") {
    state.waitingAnswer = null;
    return handleImageFirst(event, state);
  }

  // テキスト
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    if (text === "メニュー") {
      return replyMenu(event.replyToken);
    }

    if (state.waitingAnswer?.status === "waiting_student_answer") {
      if (text.includes("解説") || text.includes("そのまま")) {
        return handleImageExplainOnly(event, state);
      }
      return handleImageWithStudentAnswer(event, state, text);
    }

    return handleFreeText(event, state);
  }
}

// -----------------------------------------------
// 起動
// -----------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on ${port}`);
});
