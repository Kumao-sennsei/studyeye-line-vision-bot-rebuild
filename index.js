import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

// ==============================
// 環境変数
// ==============================
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ✅ 超重要：簡易ステート（本番はDB）
const userState = new Map();

// ==============================
// Webhook
// ==============================
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
    res.status(200).end(); // ✅ 即200返す（502防止）
    for (const event of req.body.events) {
      handleEvent(event).catch(console.error);
    }
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;
  const userId = event.source.userId;

  // ------------------------------
  // 画像 → 即解説
  // ------------------------------
  if (event.message.type === "image") {
    const imageBase64 = await getImageBase64(event.message.id);

    const prompt = `
あなたは「くまお先生」🐻
生徒は「そのまま解説して」と言っています。

・質問はしない
・最初から最後まで解説
・やさしく順番に
・板書みたいに整理

ノート構成：
【今日のまとめ】
【ポイント】
【解き方】（1⃣2⃣3⃣）

語尾：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

    const result = await callVision(imageBase64, prompt);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
    return;
  }

  // ------------------------------
  // テキスト
  // ------------------------------
  const text = event.message.text;

  // ✅ 解説トリガー
  if (text.includes("そのまま解説")) {
    userState.set(userId, "explain");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "了解だよ🐻✨ 問題の画像を送ってね！",
    });
    return;
  }

  // ✅ 初期導線（必ず出す）
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "こんにちは😊🐻\n今日は何をする？",
    quickReply: {
      items: [
        qr("質問がしたい ✏️"),
        qr("講義を受けたい 📘"),
        qr("演習したい 📝"),
        qr("雑談したい ☕"),
      ],
    },
  });
}

// ==============================
// Vision API
// ==============================
async function callVision(imageBase64, instructions) {
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
            "あなたは、やさしく明るく、生徒に寄り添う先生です。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ==============================
// LINE画像取得
// ==============================
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// ==============================
// QuickReply helper
// ==============================
function qr(label) {
  return {
    type: "action",
    action: {
      type: "message",
      label,
      text: label,
    },
  };
}

// ==============================
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
