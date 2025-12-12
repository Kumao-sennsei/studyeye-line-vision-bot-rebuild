//--------------------------------------------------
// 必要モジュール
//--------------------------------------------------
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

//--------------------------------------------------
// 環境変数
//--------------------------------------------------
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

//--------------------------------------------------
// Webhook 検証
//--------------------------------------------------
app.post(
  "/webhook",
  express.json({
    verify: (req, res, buf) => {
      const signature = crypto
        .createHmac("SHA256", CHANNEL_SECRET)
        .update(buf)
        .digest("base64");
      if (signature !== req.headers["x-line-signature"]) {
        throw new Error("Invalid signature.");
      }
    },
  }),
  async (req, res) => {
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(500).end();
    }
  }
);

//--------------------------------------------------
// 🔥 質問モード トリガー判定
//--------------------------------------------------
function isQuestionTrigger(text) {
  if (!text) return false;
  return (
    text.includes("質問") ||
    text === "1" ||
    text === "①" ||
    text.toLowerCase().includes("question")
  );
}

//--------------------------------------------------
// 🔥 質問モード スタートメッセージ
//--------------------------------------------------
async function sendQuestionStartMessage(replyToken) {
  await client.replyMessage(replyToken, {
    type: "text",
    text:
      "いいね！質問モードだよ🐻✨\n\n" +
      "・問題文を送る\n" +
      "・写真を送る\n" +
      "・文章で質問する\n\n" +
      "好きな形で送ってね！",
  });
}

//--------------------------------------------------
// 🔥 質問モード メイン処理
//--------------------------------------------------
async function handleQuestionMode(event) {
  // 画像 → Vision API
  if (event.message.type === "image") {
    const base64 = await getImageBase64(event.message.id);

    const answer = await callVision(
      base64,
      "この画像の問題をわかりやすく丁寧に解説してください。ステップ順でお願いします。"
    );

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });
    return;
  }

  // テキスト → 通常GPT回答
  if (event.message.type === "text") {
    const userQuestion = event.message.text;

    const answer = await callTextModel(
      `以下の質問に、先生として優しくわかりやすく回答してください。\n\n質問：${userQuestion}`
    );

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });
  }
}

//--------------------------------------------------
// 🧠 OpenAI（テキスト回答）
//--------------------------------------------------
async function callTextModel(userText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content:
            "あなたはやさしく寄り添う先生です。小学生にもわかる言葉で説明してください。",
        },
        { role: "user", content: userText },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

//--------------------------------------------------
// 🧠 OpenAI Vision（画像回答）
//--------------------------------------------------
async function callVision(base64, instruction) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content:
            "あなたはやさしい先生です。丁寧に順番に説明してください。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

//--------------------------------------------------
// 📥 LINE 画像バイナリ取得
//--------------------------------------------------
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

//--------------------------------------------------
// 🎮 イベント処理本体
//--------------------------------------------------
async function handleEvent(event) {
  if (event.type !== "message") return;

  const msg = event.message;

  //===============================
  // 💡 質問モード トリガー
  //===============================
  if (msg.type === "text" && isQuestionTrigger(msg.text)) {
    return await sendQuestionStartMessage(event.replyToken);
  }

  //===============================
  // 💡 質問モード 本番処理
  //===============================
  if (
    msg.type === "image" ||
    (msg.type === "text" && !isQuestionTrigger(msg.text))
  ) {
    return await handleQuestionMode(event);
  }
}

//--------------------------------------------------
app.listen(3000, () => console.log("くまお先生 起動中 🐻✨"));
//--------------------------------------------------
