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
  if (event.type !== "message") return;
  const userId = event.source.userId;

  /* --------------------
     画像が来たら答え待ち
  -------------------- */
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
        "もし無ければ「答えなし」と送ってくれたら、くまお先生が解くよ🔥",
    });
  }

  /* --------------------
     テキスト処理
  -------------------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* あいさつ */
  if (["こんにちは", "はじめまして", "やあ"].includes(text)) {
    return replyMenu(event.replyToken);
  }

  /* 質問モードに入る */
  if (text === "①" || text === "質問" || text === "質問がしたい") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章で質問してもいいし、画像を送ってもOKだよ。",
    });
  }

  /* 画像の公式答えを受け取る */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    userState[userId] = null;

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    try {
      const base64 = await getImageBase64(imageId);
      let explanation = await runVisionQuestionMode(
        base64,
        officialAnswer
      );

      explanation = sanitizeOutput(explanation);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: explanation,
      });

      return followUp(event.replyToken);
    } catch (err) {
      console.error(err);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ごめんね、画像の処理でエラーが出たみたい🙏 もう一度送ってね。",
      });
    }
  }

  /* 文章質問 */
  if (userState[userId]?.mode === "question_text") {
    userState[userId] = null;

    let answer = await runTextQuestionMode(text);
    answer = sanitizeOutput(answer);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });

    return followUp(event.replyToken);
  }

  return replyMenu(event.replyToken);
}

/* =====================
   画像質問 GPT
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。
明るく優しく、中高生に寄り添って説明します。

【絶対ルール】
・Markdown 記号は禁止
・LaTeX 記号は禁止
・強調記号は禁止
・数式は日本語で説明
・文は短く、板書のように

【構成】
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

  return await callOpenAI(messages, "gpt-4.1");
}

/* =====================
   文章質問 GPT
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」です。
やさしく丁寧に説明します。

1. 問題の要点
2. 解き方
3. 解説
4. 答え

最後に：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  return await callOpenAI(
    [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
    "gpt-4o"
  );
}

/* =====================
   OpenAI 共通
===================== */
async function callOpenAI(messages, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  const json = await res.json();
  return json.choices[0].message.content;
}

/* =====================
   禁止記号フィルター
===================== */
function sanitizeOutput(text) {
  return text
    .replace(/[*_~`]/g, "")
    .replace(/\\[()[\]$]/g, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "");
}

/* =====================
   フォローアップ会話
===================== */
function followUp(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "ほかにも聞きたいことある？🐻✨\n" +
      "それとも、この問題の類題を解いてみる？",
  });
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
   画像取得
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
  console.log("🐻✨ 質問モード完全体 起動！");
});
