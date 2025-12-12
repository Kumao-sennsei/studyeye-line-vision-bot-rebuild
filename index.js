// ===============================
// 質問モード 完全版 index.js
// 禁止記号フィルター + 指数表示 + 会話遷移つき
// ===============================

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
// after_answer
// exercise_ready
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

  // ---------- 画像 ----------
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
        "手元にない場合は「答えなし」と送ってくれたら、くまお先生が解くよ🔥",
    });
  }

  // ---------- テキスト ----------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 挨拶
    if (["こんにちは", "はじめまして", "やあ"].includes(text)) {
      userState[userId] = { mode: "idle" };
      return replyMenu(event.replyToken);
    }

    // 質問モード開始
    if (text === "①" || text === "質問がしたい") {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！質問モードだよ🐻✨\n\n" +
          "・文章で質問してもOK\n" +
          "・画像で送ってもOK\n\n" +
          "好きな方法で聞いてね！",
      });
    }

    // 画像の公式答え待ち
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = { mode: "after_answer" };

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      const base64 = await getImageBase64(imageId);
      const raw = await runVisionQuestionMode(base64, officialAnswer);
      const result = formatOutput(raw);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });

      return followUp(userId, event.replyToken);
    }

    // 文章質問
    if (userState[userId]?.mode === "question_text") {
      userState[userId] = { mode: "after_answer" };

      const raw = await runTextQuestionMode(text);
      const result = formatOutput(raw);

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });

      return followUp(userId, event.replyToken);
    }

    // 解答後の会話
    if (userState[userId]?.mode === "after_answer") {
      if (text.includes("類題")) {
        userState[userId] = { mode: "exercise_ready" };
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "OK！類題に行こう🐻🔥\n次の問題を出すね！",
        });
      }

      if (text.includes("他") || text.includes("質問")) {
        userState[userId] = { mode: "question_text" };
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "じゃあ、また質問してみよう🐻✨",
        });
      }

      return followUp(userId, event.replyToken);
    }

    return replyMenu(event.replyToken);
  }
}

/* =====================
   フォローアップ
===================== */
function followUp(userId, replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "ほかに聞きたいことはある？😊\n" +
      "それともこの問題の類題を解いてみる？🐻✨",
  });
}

/* =====================
   Vision 質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。

【絶対ルール】
・Markdown禁止
・LaTeX禁止
・強調記号禁止
・使ってよい装飾は「・」のみ
・＋ − × ÷ ^ は使用OK
・指数は x^2 の形で書く
・文章は板書風で短く

【構成】
問題の要点
解き方（1⃣ 2⃣ 3⃣ 必要なら追加）
解説
答え
最後に一言
`;

  const messages = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは「${officialAnswer}」です。`
            : "公式の答えはありません。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  return callOpenAI(messages);
}

/* =====================
   文章質問
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」です。

【ルール】
・Markdown禁止
・LaTeX禁止
・指数は x^2 形式
・＋ − × ÷ 使用OK
・板書のように説明

【構成】
問題の要点
解き方（番号つき）
解説
答え
最後に一言
`;

  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: text },
  ];

  return callOpenAI(messages);
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
   出力整形
===================== */
function formatOutput(text) {
  return text
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\^2/g, "²")
    .replace(/\^3/g, "³")
    .replace(/\^4/g, "⁴");
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
      "① 質問がしたい\n",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問モード 完全版 起動！");
});
