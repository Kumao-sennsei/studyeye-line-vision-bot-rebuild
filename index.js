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
// mode:
// idle
// question_text
// waiting_answer
// answered
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
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
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
        "この問題の公式の答え（問題集・プリントの答え）を送ってね。\n" +
        "なければ「答えなし」でOKだよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* ---------- あいさつ ---------- */
  if (["こんにちは", "やあ", "はじめまして"].includes(text)) {
    userState[userId] = { mode: "idle" };
    return replyMenu(event.replyToken);
  }

  /* ---------- 質問開始 ---------- */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章で送ってもいいし、画像でもOKだよ。",
    });
  }

  /* ---------- 文章質問 ---------- */
  if (userState[userId]?.mode === "question_text") {
    userState[userId] = { mode: "answered" };

    const result = await runTextQuestionMode(text);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result + "\n\nほかに聞きたいことある？それともこの問題の類題を解いてみる？",
    });
  }

  /* ---------- 画像の答え受信 ---------- */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    userState[userId] = { mode: "answered" };

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result + "\n\nほかに聞きたいことある？それともこの問題の類題を解いてみる？",
    });
  }

  /* ---------- 回答後の会話 ---------- */
  if (userState[userId]?.mode === "answered") {
    if (text.includes("類題")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！類題に行こう🐻🔥\n（ここから演習モードに接続予定）",
      });
    }

    if (text.includes("ある") || text.includes("質問")) {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "いいよ！続けて質問してね🐻✨",
      });
    }
  }

  return replyMenu(event.replyToken);
}

/* =====================
   Vision 質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。
中高生に向けて、黒板に書くように説明します。

書式ルール
・*, **, __, ~~ は絶対に使わない
・× や − は使ってよい
・数式は普通の文字で書く
・箇条書きは「・」のみ
・文は短く、整理して書く

構成
1. 問題の要点
2. 解き方（ステップ形式）
3. 解説
4. 答え

最後に必ず：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  const messages = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは ${officialAnswer} です。`
            : "公式の答えはありません。自分で解いてください。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  return sanitize(await callOpenAI(messages));
}

/* =====================
   文章質問
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。
やさしく、正確に説明します。

構成
1. 問題の要点
2. 解き方
3. 解説
4. 答え

最後に：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  return sanitize(
    await callOpenAI([
      { role: "system", content: prompt },
      { role: "user", content: text },
    ])
  );
}

/* =====================
   禁止記号フィルター
===================== */
function sanitize(text) {
  return text.replace(/[*_~`]/g, "");
}

/* =====================
   OpenAI
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
   LINE画像 → base64
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
      "こんにちは🐻✨\n" +
      "① 質問がしたい",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問モード 完全体 起動");
});
