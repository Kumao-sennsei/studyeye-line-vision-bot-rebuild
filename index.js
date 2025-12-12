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
    } catch (err) {
      console.error(err);
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
        "なければ「答えなし」でOKだよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* あいさつ */
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
      const result = await runVisionQuestionMode(base64, officialAnswer);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: sanitizeOutput(result),
      });
    }

    /* 質問モード */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "質問モードだよ🐻✨\n" +
          "文章でも画像でも送ってね。",
      });
    }

    /* 文章質問 */
    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;
      const result = await runTextQuestionMode(text);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: sanitizeOutput(result),
      });
    }

    return replyMenu(event.replyToken);
  }
}

/* =====================
   Vision 質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const systemPrompt = `
あなたは「くまお先生」です。
明るく優しく、中高生に寄り添って説明します。

【絶対ルール】
・Markdown記号は禁止
・LaTeXは禁止
・太字、強調、装飾は禁止
・使ってよい装飾は「・」のみ
・数式は日本語で説明
・文は短く、板書のように

【構成】
1. 問題の要点
2. 解き方
3. 解説
4. 答え

最後は必ず：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  const userText = officialAnswer
    ? `公式の答えは「${officialAnswer}」です。これを基準に説明してください。`
    : "公式の答えはありません。問題を解いて説明してください。";

  return await callOpenAI([
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

/* =====================
   文章質問
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」です。

【構成】
1. 問題の要点
2. 解き方
3. 解説
4. 答え

最後に：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  return await callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   OpenAI 呼び出し
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
   禁止記号フィルター（最重要）
===================== */
function sanitizeOutput(text) {
  return text
    .replace(/\*\*|\*|__|_|~~/g, "")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$/g, "")
    .replace(/#+/g, "")
    .trim();
}

/* =====================
   LINE画像取得
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
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
      "① 質問がしたい ✏️",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 禁止記号フィルター完全版 起動！");
});
