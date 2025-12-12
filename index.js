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
// userState[userId] = { mode, imageId }
const userState = {};

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

  /* ---------- 画像 ---------- */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答え（問題集やプリントの答え）を送ってね。\n" +
        "もし無ければ「答えなし」と送ってくれたら、くまお先生が代わりに解くよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* 挨拶 */
    if (["こんにちは", "やあ", "はじめまして"].includes(text)) {
      return replyMenu(event.replyToken);
    }

    /* 公式答え待ち */
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      const base64 = await getImageBase64(imageId);

      const raw = await runVisionInternal(base64, officialAnswer);
      const safe = sanitizeOutput(raw);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: safe,
      });
    }

    /* 質問モード */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "質問モードだよ🐻✨\n\n" +
          "文章で質問してもいいし、画像を送ってもOKだよ。",
      });
    }

    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;

      const raw = await runTextInternal(text);
      const safe = sanitizeOutput(raw);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: safe,
      });
    }

    return replyMenu(event.replyToken);
  }
}

/* =====================
   内部計算フェーズ（画像）
===================== */
async function runVisionInternal(imageBase64, officialAnswer) {
  const messages = [
    {
      role: "system",
      content:
        "あなたは数学計算エンジン。正確な計算を最優先。説明不要。",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは ${officialAnswer}。それを基準に内部計算を行う。`
            : "公式の答えは無い。問題を解いて正しい答えを出す。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  const calculation = await callOpenAI(messages);

  return await runDisplayTransform(calculation);
}

/* =====================
   内部計算フェーズ（文章）
===================== */
async function runTextInternal(text) {
  const messages = [
    {
      role: "system",
      content:
        "あなたは数学計算エンジン。正確な計算を最優先。説明不要。",
    },
    { role: "user", content: text },
  ];

  const calculation = await callOpenAI(messages);

  return await runDisplayTransform(calculation);
}

/* =====================
   表示変換フェーズ
===================== */
async function runDisplayTransform(calculationText) {
  const messages = [
    {
      role: "system",
      content:
        "あなたはくまお先生。中高生向けにやさしく板書風で説明する。",
    },
    {
      role: "user",
      content:
        "以下の計算結果を、生徒向けに説明に直す。\n" +
        "禁止事項：Markdown、記号装飾、LaTeX。\n\n" +
        calculationText,
    },
  ];

  return await callOpenAI(messages);
}

/* =====================
   禁止記号フィルター
===================== */
function sanitizeOutput(text) {
  return text
    .replace(/[*_~`]/g, "")
    .replace(/\\\[.*?\\\]/g, "")
    .replace(/\\\(.*?\\\)/g, "")
    .replace(/\$/g, "");
}

/* =====================
   OpenAI 共通
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
   LINE画像取得
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
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 禁止記号フィルター統合版 起動！");
});
