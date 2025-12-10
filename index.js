import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
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
    // ✅ まず即200返す（超重要）
    res.status(200).end();

    // あとは裏で処理
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

  // ------------------------------
  // 画像 → 即解説
  // ------------------------------
  if (event.message.type === "image") {
    try {
      const imageBase64 = await getImageBase64(event.message.id);

      const prompt = `
あなたは「くまお先生」。
生徒は「そのまま解説して」と言っています。

・質問を返さず、最初から最後まで説明
・やさしく、順番に
・板書のように整理

ノート構成：
【今日のまとめ】
【ポイント】
【解き方】（計算があれば 1⃣2⃣3⃣）

語尾：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

      const result = await callVision(imageBase64, prompt);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    } catch (e) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "ごめんね💦 画像の読み取りで失敗したよ。もう一度送ってくれる？🐻",
      });
    }
    return;
  }

  // ------------------------------
  // テキスト
  // ------------------------------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 解説トリガー
    if (text.includes("解説")) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "OKだよ🐻✨ 問題の画像を送ってね！",
      });
      return;
    }

    // 初期ボタン
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "こんにちは😊🐻\n今日は何をする？",
      quickReply: {
        items: [
          {
            type: "action",
            action: { type: "message", label: "質問がしたい ✏️", text: "質問がしたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "講義を受けたい 📘", text: "講義を受けたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "演習したい 📝", text: "演習したい" },
          },
          {
            type: "action",
            action: { type: "message", label: "雑談したい ☕", text: "雑談したい" },
          },
        ],
      },
    });
  }
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
        { role: "system", content: "やさしく明るい先生として説明してください。" },
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

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "うまく読み取れなかったよ🐻💦";
}

// ==============================
// LINE画像取得
// ==============================
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

// ==============================
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
