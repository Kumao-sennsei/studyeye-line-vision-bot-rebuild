// ================================================
// StudyEye くまお先生 - 完全安定版 index.js（ノート生成機能統合）
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

const client = new line.Client(config);
const app = express(); // express.json() は後ろで使う

// -----------------------------------------------
// グローバル state
// -----------------------------------------------
const globalState = {};

function getUserState(userId) {
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      lastAnswer: null,
      waitingAnswer: null,
    };
  }
  return globalState[userId];
}

// -----------------------------------------------
// 整形処理（Markdown禁止）
// -----------------------------------------------
function sanitize(text) {
  if (!text) return "";
  return text
    .replace(/[#$*_`>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -----------------------------------------------
// OpenAI Access
// -----------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function callChat(model, messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!res.ok) {
    console.error(await res.text());
    throw new Error("Chat API error");
  }

  const data = await res.json();
  return sanitize(data.choices?.[0]?.message?.content || "");
}

async function callVision(imageBase64, instructions) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: visionSystemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            }
          ]
        }
      ]
    })
  });

  if (!res.ok) {
    console.error(await res.text());
    throw new Error("Vision API error");
  }

  const data = await res.json();
  return data.choices[0].message.content;
}


// -----------------------------------------------
// LINE返信
// -----------------------------------------------
function reply(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

// -----------------------------------------------
// 画像取得
// -----------------------------------------------
async function getImageBase64(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    stream.on("error", reject);
  });
}

// -----------------------------------------------
// FREEモード
// -----------------------------------------------
async function handleFreeText(event, state) {
  const text = event.message.text.trim();

  const system = `
あなたは「くまお先生」です。
生徒のすぐ隣に立って、一緒に黒板を見ながら説明する先生です。

基本スタンス：
・やさしく、落ち着いた口調
・上から目線にならない
・生徒と同じ側に立つ
・否定せず、必ず寄り添う

話し方のルール：
・「じゃあ」「まずは」「ここ大事だよ」など自然な会話を使う
・説明しているというより、一緒に考えている雰囲気を出す
・短い文を積み重ねる（板書スタイル）
・LINEで読みやすいように改行を多めにする

説明のしかた：
・数式を書いたら、すぐ言葉で補足する
・考え方の流れを大切にする
・間違えやすいところは、やさしく注意する
・長くなりすぎない。シンプルを優先する

禁止事項：
・Markdown記号（#, *, **, \`\`\` など）を使わない
・「結論から言うと」「一般的には」などAIっぽい言い回し禁止
・「計算機を使います」という表現は禁止

会話のルール：
・生徒が「教科」や「分野」だけを答えた場合は、
　すぐに解説を始めない
・必ず「どんな問題？」「問題文を送ってね」と確認する
・生徒の入力が出そろってから、初めて説明を始める

・画像がすでに送られている場合、
　これ以上「問題を送って」と言ってはいけない
・「解説して」と言われたら、
　即、問題文の整理から始める



最後に：
・必ず生徒を前向きにする一言を添える
（例：この考え方、覚えておくと強いよ🐻✨）
`;

  const user =
    "【生徒の質問】\n" +
    text +
    "\n\n【ルール】\n" +
    "・最初にひと言添える（例：ここから一緒に見ていこうか🐻）\n" +
    "・板書風にやさしく解説\n" +
    "・間違えやすいポイントを言及\n" +
    "・最後に励ます";

  const ans = await callChat("gpt-4o", [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);

  state.lastAnswer = ans;

  return reply(event.replyToken, ans);
}

// -----------------------------------------------
// 画像：最初の案内
// -----------------------------------------------
async function handleImageFirst(event, state) {
  const base64 = await getImageBase64(event.message.id);

  state.waitingAnswer = {
    kind: "image",
    imageBase64: base64,
    status: "waiting_student",
  };

  return reply(
    event.replyToken,
    "この問題、もし自分の答えがあれば送ってね🐻✨\n・答えを送る → 採点＆解説\n・なければ「そのまま解説して」でOKだよ！"
  );
}

// -----------------------------------------------
// 画像：答え付き
// -----------------------------------------------
async function handleImageWithAnswer(event, state, student) {
  const base64 = state.waitingAnswer.imageBase64;

  const instructions =
    "画像の問題文を正確に書き起こし、板書のように解説し、最後に答えを1行でまとめてください。\n" +
    "次に、生徒の答えと比較して採点し、正解/惜しい/不正解を述べてください。\n\n" +
    "【生徒の答え】\n" +
    student;

  const ans = await callVision(base64, instructions);

  state.waitingAnswer = null;
  state.lastAnswer = ans;

  return reply(event.replyToken, ans);
}

// -----------------------------------------------
// 画像：答えなし
// -----------------------------------------------
async function handleImageExplain(event, state) {
  const base64 = state.waitingAnswer.imageBase64;

  const instructions =
    "画像の問題文を正確に書き起こし、板書のように丁寧に解説してください。最後に答えを1行でまとめてください。採点は不要です。";

  const ans = await callVision(base64, instructions);

  state.waitingAnswer = null;
  state.lastAnswer = ans;

  return reply(event.replyToken, ans);
}

// -----------------------------------------------
// ノート生成（まとめて / ノート / 要点）
// -----------------------------------------------
async function generateNote(event, state) {
  if (!state.lastAnswer) {
    return reply(event.replyToken, "まだ授業の内容がないみたいだよ。何か質問してみようか🐻✨");
  }

  const instructions =
    "以下の授業内容を、くまお先生のノート形式に変換してください。\n\n" +
    "【今日のまとめ】\n" +
    "・授業で扱ったポイントを箇条書き\n" +
    "【ポイント】\n" +
    "・公式や考え方を順番に簡潔に書く\n" +
    "【解き方】\n" +
    "数学・理科の計算問題の場合のみ、1⃣→2⃣→3⃣ の順で手順を書く\n" +
    "【ここがポイント！】（間違えやすい部分）\n" +
    "・簡単なチェック問題（任意）\n" +
    "最後は「このページ、ノートに写しておくと復習しやすいよ🐻✨」と書く\n" +
    "Markdown 記号は禁止。\n\n" +
    "【授業内容】\n" +
    state.lastAnswer;

  const note = await callChat("gpt-4o", [
    { role: "system", content: "あなたは優しいくまお先生。内容をノート形式に変換するプロ。" },
    { role: "user", content: instructions },
  ]);

  return reply(event.replyToken, note);
}

// -----------------------------------------------
// メインイベントハンドラ
// -----------------------------------------------
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  const state = getUserState(userId);

  // 画像
  if (event.message.type === "image") {
     state.hasQuestion = true;   // ★これを追加

    state.waitingAnswer = null;
    return handleImageFirst(event, state);
  }

  // テキスト
  if (event.message.type === "text") {
    const t = event.message.text.trim();

    // ノート生成
    if (
      t.includes("まとめ") ||
      t.includes("ノート") ||
      t.includes("要点")
    ) {
      return generateNote(event, state);
    }

    // 画像の答え待ち
    if (state.waitingAnswer?.status === "waiting_student") {
      if (t.includes("解説") || t.includes("そのまま")) {
        return handleImageExplain(event, state);
      }
      return handleImageWithAnswer(event, state, t);
    }

    // FREEモード
    return handleFreeText(event, state);
  }
}

// -----------------------------------------------
// Webhook（署名検証OK）
// -----------------------------------------------
app.post("/webhook", line.middleware(config), (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  events.forEach((ev) => handleEvent(ev));
});

// express.json() は middleware の後！
app.use(express.json());

// -----------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("server running", port));
