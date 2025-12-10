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
// Webhook 検証
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
async function handleTextMessage(event, state) {
  const text = event.message.text.trim();

  // --- 強制トリガー：解説開始 ---
  if (
    text.includes("そのまま解説") ||
    text.includes("解説して") ||
    text.includes("説明して")
  ) {
    if (!state.lastImageBase64) {
      return replyText(event.replyToken,
        "画像がまだ届いていないみたいだよ🐻💦\n問題の写真を送ってね。"
      );
    }

    state.mode = "explaining";

    const instructions = `
あなたは、やさしくて明るい「くまお先生🐻✨」です。
生徒は「そのまま解説して」と言っています。

【必ず守ること】
・画像の問題を読み取って解説を開始する
・途中で質問を挟まない
・式 → 考え方 → 計算 → 答え の順で説明
・中学生〜高校生にわかる言葉で
・最後に「ノートまとめ」を出す

【ノート構成】
【今日のまとめ】
・ポイントを箇条書き

【ポイント】
・考え方・公式

【解き方】
1⃣〜順番に

語尾：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

    const result = await callVision(state.lastImageBase64, instructions);
    return replyText(event.replyToken, result);
  }

  // --- 通常フロー ---
  if (text.includes("数学")) {
    state.mode = "waiting_problem";
    return replyText(event.replyToken,
      "いいね😊\n問題文か写真を送ってね🐻✨"
    );
  }

  return replyText(event.replyToken,
    "どんなことをしたいか教えてね🐻✨\n\n📘 質問\n📗 講義を受けたい\n✏️ 演習したい\n💬 雑談したい"
  );
}


  // ------------------------------
  // テキストメッセージ
  // ------------------------------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // ★ 解説トリガー
    if (
      text.includes("そのまま解説") ||
      text.includes("解説して") ||
      text.includes("教えて") ||
      text.includes("説明して")
    ) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "了解だよ🐻✨ 問題の画像を送ってね！",
      });
      return;
    }

    // ★ 最初の導線
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "こんにちは😊🐻\n\n" +
        "今日は何をする？\n" +
        "👇 えらんでね！\n\n" +
        "① 質問がしたい ✏️\n" +
        "② 講義を受けたい 📘\n" +
        "③ 演習したい 📝\n" +
        "④ 雑談したい ☕\n\n" +
        "画像の問題も、そのまま送ってOKだよ✨",
    });
  }
}

// ==============================
// Vision API 呼び出し
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
            "あなたは、やさしく明るく、生徒に寄り添う先生です。難しい言葉は使わず、順番に説明します。",
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
