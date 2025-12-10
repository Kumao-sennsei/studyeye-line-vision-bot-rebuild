import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* ==============================
  環境変数
============================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ==============================
  Webhook（最重要）
============================== */
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
    // ✅ まず即200（タイムアウト防止）
    res.status(200).end();

    try {
      await Promise.all(req.body.events.map(handleEvent));
    } catch (e) {
      console.error("handleEvent error:", e);
    }
  }
);

/* ==============================
  メイン処理
============================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  /* ===== 画像が来たら即解説 ===== */
  if (event.message.type === "image") {
    const imageBase64 = await getImageBase64(event.message.id);

    const prompt = `
あなたは「くまお先生」。
生徒は「そのまま解説して」と言っています。

・途中で質問はしない
・最初から最後まで丁寧に説明
・数式は省略しすぎない
・板書みたいに整理

【今日のまとめ】
【ポイント】
【解き方】（1⃣→2⃣→3⃣）

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

  /* ===== テキスト処理 ===== */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // --- ボタン分岐 ---
    if (text === "質問") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "いいね😊 質問したい問題を送ってね！画像でもOKだよ🐻✨",
      });
      return;
    }

    if (text === "講義") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "了解📘 どの教科・単元を講義する？",
      });
      return;
    }

    if (text === "演習") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "よっしゃ📝 演習したい内容を教えて！",
      });
      return;
    }

    if (text === "雑談") {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "雑談しよ☕ 最近どう？🐻",
      });
      return;
    }

    // --- 初期メニュー ---
    await client.replyMessage(event.replyToken, {
      type: "template",
      altText: "メニュー",
      template: {
        type: "buttons",
        title: "こんにちは🐻✨",
        text: "今日は何をする？",
        actions: [
          { type: "message", label: "① 質問がしたい", text: "質問" },
          { type: "message", label: "② 講義を受けたい", text: "講義" },
          { type: "message", label: "③ 演習がしたい", text: "演習" },
          { type: "message", label: "④ 雑談したい", text: "雑談" },
        ],
      },
    });
  }
}

/* ==============================
  Vision API
============================== */
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
            "あなたは優しく丁寧な先生です。中学生にもわかる説明をします。",
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

/* ==============================
  LINE画像取得
============================== */
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

/* ==============================
  起動
============================== */
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
