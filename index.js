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
// ◆ 状態管理（最重要）
// ==============================
let currentMode = "menu"; // "question" / "lecture" / "practice" / "chat"

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

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  const msg = event.message;

  // =========================================
  // ◆ 画像 → 現在のモードに合わせて処理
  // =========================================
  if (msg.type === "image") {
    if (currentMode === "question") {
      const base64 = await getImageBase64(msg.id);
      const answer = await visionAnswer(base64);
      await reply(event, answer);
      return;
    }

    // 画像を送ってもモード外なら案内
    await reply(event, "画像を送ったね！✨\n今は質問モードじゃないよ。\nメニューからやりたいことを選んでね🐻✨");
    return;
  }

  // =========================================
  // ◆ テキスト処理
  // =========================================
  const text = msg.text.trim();

  // -----------------------------------------
  // ◆ メニュー選択
  // -----------------------------------------
  if (text.includes("質問") || text === "①" || text === "1") {
    currentMode = "question";
    return reply(
      event,
      "いいね！質問モードだよ🐻✨\n\n" +
        "・問題文を送る\n" +
        "・写真を送る\n" +
        "・文章で質問する\n\n" +
        "好きな形で送ってね！"
    );
  }

  if (text.includes("講義") || text === "②" || text === "2") {
    currentMode = "lecture";
    return reply(
      event,
      "了解！講義モードだよ📘✨\n\n" +
        "教科と単元を送ってね！\n例）数学 2次関数"
    );
  }

  if (text.includes("演習") || text === "③" || text === "3") {
    currentMode = "practice";
    return reply(
      event,
      "演習モード開始するよ📝✨\n\n" +
        "教科と単元を送ってね！\n例）数学 2次関数"
    );
  }

  if (text.includes("雑談") || text === "④" || text === "4") {
    currentMode = "chat";
    return reply(event, "雑談モードにするね☕✨ なんでも話してね！");
  }

  // -----------------------------------------
  // ◆ 質問モードのテキスト質問
  // -----------------------------------------
  if (currentMode === "question") {
    const answer = await chatGPT(text);
    await reply(event, answer);
    return;
  }

  // -----------------------------------------
  // ◆ どのモードでもない → メニュー表示
  // -----------------------------------------
  return reply(
    event,
    "こんにちは🐻✨\n今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習がしたい 📝\n" +
      "④ 雑談したい ☕"
  );
}

// ==============================
// OpenAI ChatGPT（テキスト質問）
// ==============================
async function chatGPT(userText) {
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
            "あなたはくまお先生。優しく分かりやすく解説する先生です。",
        },
        { role: "user", content: userText },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ==============================
// OpenAI Vision（画像解説）
// ==============================
async function visionAnswer(base64) {
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
            "あなたは写真の問題を読み取り、やさしく順番に解説する先生です。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "この問題を解説してください。" },
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

// ==============================
// 画像取得
// ==============================
async function getImageBase64(id) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${id}/content`,
    {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// ==============================
async function reply(event, text) {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

app.listen(3000, () => console.log("くまお先生 起動中 🐻✨"));
