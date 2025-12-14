import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* =====================
   環境変数
===================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* =====================
   LINE クライアント
===================== */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* =====================
   ユーザー状態
===================== */
const userState = {};

/* =====================
   🐻 共通プロンプト（JS安全）
===================== */

const BASE_RULE_PROMPT = `
あなたは「くまお先生」。
やさしく、落ち着いて、生徒に寄り添って説明します🐻✨

【表記ルール（必ず守る）】
・LINE上で読みやすい文章のみを使う
・「**」「---」「===」などの装飾記号は禁止
・数式は最小限にする
・√、√2、〇²³ のような表記は使用OK
・分数は a/b の形で書く
・LaTeX記法（\\frac, \\sin 等）は使わない

【解説テンプレ（厳守）】
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】
`;

const EXERCISE_RULE_PROMPT = `
【類題ルール】
・類題には必ず【答え】をつける
・記述問題は【正答例】を必ず書く
・解説は簡潔でよい
・直前の問題と同じ単元・同じ考え方
・「数値だけ変えて」と指定されたら必ず従う
`;

const QUESTION_SYSTEM_PROMPT = BASE_RULE_PROMPT;
const EXERCISE_SYSTEM_PROMPT = BASE_RULE_PROMPT + EXERCISE_RULE_PROMPT;

/* =====================
   Webhook
===================== */
app.post(
  "/webhook",
  express.json({
    verify: (req, res, buf) => {
      const signature = crypto
        .createHmac("SHA256", CHANNEL_SECRET)
        .update(buf)
        .digest("base64");
      if (signature !== req.headers["x-line-signature"]) {
        throw new Error("Invalid signature");
      }
    },
  }),
  async (req, res) => {
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (e) {
      console.error(e);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.message.type === "image") {
    userState[userId] = { mode: "waiting_answer", imageId: event.message.id };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n" +
        "この問題の公式の答えがあれば送ってね。\n" +
        "なければ「答えなし」でOKだよ😊",
    });
  }

  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  if (userState[userId]?.mode === "waiting_answer") {
    const base64 = await getImageBase64(userState[userId].imageId);
    const result = await runVisionQuestionMode(base64);
    userState[userId] = { mode: "after_question" };
    return client.replyMessage(event.replyToken, { type: "text", text: result });
  }

  if (text === "①" || text === "質問がしたい") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章でも、問題の写真でも送ってOKだよ😊",
    });
  }

  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestionMode(text);
    userState[userId] = { mode: "after_question", lastQuestion: text };
    return client.replyMessage(event.replyToken, { type: "text", text: result });
  }

  return replyMenu(event.replyToken);
}

/* =====================
   OpenAI 呼び出し
===================== */
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages,
    }),
  });

  const json = await res.json();
  return json.choices[0].message.content;
}

/* =====================
   質問モード
===================== */
async function runTextQuestionMode(text) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
}

/* =====================
   Vision質問（応急安定版）
===================== */
async function runVisionQuestionMode(imageBase64) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: "この画像の問題を読み取って解説して。" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

/* =====================
   画像取得
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

/* =====================
   メニュー
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n" +
      "今日は何をする？\n" +
      "① 質問がしたい😊\n" +
      "② 講義を受けたい📘\n" +
      "③ 演習（類題）をしたい✏️\n" +
      "④ 雑談がしたい☕",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 起動しました");
});
