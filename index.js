import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ==============================
// ユーザー状態（超重要）
// ==============================
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
  (req, res) => {
    // ✅ 先に200返す（最重要）
    res.status(200).end();

    // 裏で処理
    req.body.events.forEach(handleEvent).catch(console.error);
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;

  // ------------------------------
  // 画像 → 解説モードなら即解析
  // ------------------------------
  if (event.message.type === "image") {
    if (userState.get(userId) !== "explain") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "この問題、解説していいかな？\n「そのまま解説して」って送ってね🐻✨",
      });
      return;
    }

    const imageBase64 = await getImageBase64(event.message.id);
    const result = await callVision(imageBase64);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });

    userState.delete(userId);
    return;
  }

  // ------------------------------
  // テキスト
  // ------------------------------
  const text = event.message.text.trim();

  if (text.includes("そのまま解説")) {
    userState.set(userId, "explain");
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "了解だよ🐻✨ 問題の画像を送ってね！",
    });
    return;
  }

  // ------------------------------
  // 初期ボタン
  // ------------------------------
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "こんにちは😊🐻\n今日は何をする？",
    quickReply: {
      items: [
        replyBtn("質問がしたい"),
        replyBtn("講義を受けたい"),
        replyBtn("演習がしたい"),
        replyBtn("雑談がしたい"),
      ],
    },
  });
}

// ==============================
// Vision API
// ==============================
async function callVision(imageBase64) {
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
          content: `
あなたは「くまお先生」。
途中で質問せず、最初から最後までやさしく解説。

【今日のまとめ】
【ポイント】
【解き方】1⃣2⃣3⃣

語尾：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`,
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ==============================
// 画像取得
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
function replyBtn(label) {
  return {
    type: "action",
    action: { type: "message", label, text: label },
  };
}

app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
