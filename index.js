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
    // ✅ 先に200を返す（超重要）
    res.status(200).end();

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

  // ---------- テキスト ----------
  if (event.message.type === "text") {
    await client.replyMessage(event.replyToken, {
      type: "flex",
      altText: "メニュー",
      contents: menuFlex(),
    });
    return;
  }

  // ---------- 画像 ----------
  if (event.message.type === "image") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像ありがとう🐻✨\n\n" +
        "この問題を【そのまま最初から】解説するね。\n" +
        "少し待っててね📘",
    });

    const imageBase64 = await getImageBase64(event.message.id);
    const answer = await callVision(imageBase64);

    await client.pushMessage(event.source.userId, {
      type: "text",
      text: answer,
    });
  }
}

// ==============================
// メニュー（安定版）
// ==============================
function menuFlex() {
  const btn = (label, emoji) => ({
    type: "button",
    style: "primary",
    action: { type: "message", label, text: label },
    color: "#6FCF97",
  });

  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: "こんにちは🐻✨", weight: "bold", size: "lg" },
        { type: "text", text: "今日は何をする？", wrap: true },
        btn("質問がしたい ✏️"),
        btn("講義を受けたい 📘"),
        btn("演習がしたい 📝"),
        btn("雑談したい ☕"),
      ],
    },
  };
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
          content:
            "あなたはくまお先生。やさしく順番に、途中で質問せず最後まで解説する。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "この問題をそのまま解説して。" },
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
