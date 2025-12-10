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
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (e) {
      console.error(e);
      res.status(500).end();
    }
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  // ------------------------------
  // ✅ 画像 → 無条件で即解説
  // ------------------------------
  if (event.message.type === "image") {
    const imageBase64 = await getImageBase64(event.message.id);

    const prompt = `
あなたは「くまお先生」🐻✨
生徒は「そのまま解説して」と言っています。

・途中で質問しない
・最初から最後まで丁寧に解説
・数式は順番に
・最後にノートまとめを出す

【ノート構成】
【今日のまとめ】
【ポイント】
【解き方】（1⃣2⃣3⃣…）

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
  // ✅ テキスト
  // ------------------------------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 解説トリガー
    if (text.includes("解説")) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "了解だよ🐻✨ 問題の画像を送ってね！",
      });
      return;
    }

    // ✅ 最初の案内（ボタン）
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "こんにちは🐻✨\n今日は何をする？",
      quickReply: {
        items: [
          {
            type: "action",
            action: { type: "message", label: "質問がしたい", text: "質問がしたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "講義を受けたい", text: "講義を受けたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "演習がしたい", text: "演習がしたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "雑談がしたい", text: "雑談がしたい" },
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
        {
          role: "system",
          content:
            "あなたは、やさしく明るく、かみくだいて教える先生です。",
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
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
