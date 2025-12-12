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
// question_text
// question_waiting_answer (画像→答え待ち)
// question_after_answer (解説後フォロー)
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

  /* ========= 画像 ========= */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "question_waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答えを送ってね。\n" +
        "もし無ければ「答えなし」と送ってくれたら大丈夫だよ。",
    });
  }

  /* ========= テキスト ========= */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* --- 質問モード開始 --- */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n\n" +
        "・文章で質問してもOK\n" +
        "・問題の写真を送ってもOK\n\n" +
        "好きな形で聞いてね。",
    });
  }

  /* --- 画像の公式答え待ち --- */
  if (userState[userId]?.mode === "question_waiting_answer") {
    const imageId = userState[userId].imageId;
    userState[userId] = null;

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestion(base64, officialAnswer);

    userState[userId] = { mode: "question_after_answer" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result + "\n\nほかに聞きたいことある？それとも類題を解いてみる？",
    });
  }

  /* --- 文章質問 --- */
  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestion(text);
    userState[userId] = { mode: "question_after_answer" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result + "\n\nほかに聞きたいことある？それとも類題を解いてみる？",
    });
  }

  /* --- 解説後フォロー --- */
  if (userState[userId]?.mode === "question_after_answer") {
    if (text.includes("類題")) {
      userState[userId] = null;
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね🐻🔥\n" +
          "じゃあ演習モードに進もう。\n" +
          "このあと、似た問題を出すよ。",
      });
    }

    // それ以外は全部「追加質問」として処理
    const result = await runTextQuestion(text);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result + "\n\nほかにも聞く？それとも類題いく？",
    });
  }

  /* --- デフォルト --- */
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n" +
      "① 質問がしたい\n",
  });
}

/* =====================
   Vision 質問
===================== */
async function runVisionQuestion(imageBase64, officialAnswer) {
  const systemPrompt = `
あなたは「くまお先生」です。

【絶対ルール】
・Markdown記号（*, **, __, ~~）は禁止
・LaTeXは禁止
・太字や装飾は禁止
・数式は × や − を使ってOK
・文は短く、板書のように

【構成】
問題の要点
解き方（1⃣ 2⃣ 3⃣）
解説
答え
`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは「${officialAnswer}」です。これを基準に説明してください。`
            : "公式の答えはありません。問題を解いて説明してください。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  const raw = await callOpenAI(messages);
  return sanitizeOutput(raw);
}

/* =====================
   文章質問
===================== */
async function runTextQuestion(text) {
  const systemPrompt = `
あなたは「くまお先生」です。

【構成】
問題の要点
解き方（1⃣ 2⃣ 3⃣）
解説
答え
`;

  const raw = await callOpenAI([
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ]);

  return sanitizeOutput(raw);
}

/* =====================
   禁止記号フィルター
===================== */
function sanitizeOutput(text) {
  return text
    .replace(/[*_~`]/g, "")
    .replace(/\$/g, "")
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "");
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
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問モード 完全体 起動！");
});
