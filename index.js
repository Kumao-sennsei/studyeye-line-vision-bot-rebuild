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

/*
state例：
mode:
- menu
- question_waiting_input
- question_waiting_after_image

pendingImage: true/false
imageId
*/

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

  /* ===== 画像受信 ===== */
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "question_waiting_after_image",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ😊\n\n" +
        "解説の品質を最高のものにするために、\n" +
        "問題文と、もし分かれば答えも送ってね🐻✨\n\n" +
        "答えがなくても、考え方は説明できるよ！",
    });
  }

  /* ===== テキスト以外は無視 ===== */
  if (event.message?.type !== "text") return;

  const text = event.message.text.trim();

  /* ===== メニュー ===== */
  if (text === "①" || text === "質問がしたい") {
    userState[userId] = { mode: "question_waiting_input" };

    return client.replyMessage(event.replyToken, {
      type: "text",
       text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい 😊\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習（類題）をしたい ✏️\n" +
      "④ 雑談がしたい ☕"
        "解説の品質を最高のものにするために、\n" +
        "先に問題と答えを送ってください🐻✨\n\n" +
        "答えが分かっている場合は、\n" +
        "その答えに合わせて丁寧に解説します😊\n\n" +
        "答えがない場合でも、\n" +
        "解き方や考え方はしっかりお伝えできます！",
    });
  }

  /* ===== 画像後の追加入力 ===== */
  if (userState[userId]?.mode === "question_waiting_after_image") {
    const base64 = await getImageBase64(userState[userId].imageId);

    const result = await runVisionExplainOnly(
      base64,
      text
    );

    userState[userId] = { mode: "menu" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: sanitize(result),
    });
  }

  /* ===== 質問モード：文章 ===== */
  if (userState[userId]?.mode === "question_waiting_input") {
    const result = await runTextExplainOnly(text);

    userState[userId] = { mode: "menu" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: sanitize(result),
    });
  }

  /* ===== デフォルト：メニュー ===== */
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "次は何しよっか？🐻✨\n\n" +
      "① 質問がしたい 😊",
  });
}

/* =====================
   質問モード（答えを断定しない）
===================== */
async function runTextExplainOnly(text) {
  const prompt = `
あなたは「くまお先生」。
中学生・高校生に向けて、やさしく説明します。

【絶対ルール】
・正解や答えを断定しない
・数値や選択肢番号を確定しない
・考え方と解き方のみ説明する
・強調記号や装飾記号は使わない

【出力形式】
【問題の要点】
【考え方】
1⃣
2⃣
3⃣
【ポイント】

最後に
「正解が分かったら送ってね🐻✨」
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   Vision：読むだけ・断定禁止
===================== */
async function runVisionExplainOnly(imageBase64, extraText) {
  const prompt = `
あなたは「くまお先生」。

【絶対ルール】
・画像の問題を読み取るだけ
・正解を断定しない
・選択肢番号や数値を決めない
・考え方のみ説明する
・装飾記号は禁止

【出力形式】
【問題の要点】
【考え方】
1⃣
2⃣
3⃣
【ポイント】

最後に
「正解が分かったら送ってね🐻✨」
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        { type: "text", text: extraText || "問題文の補足です。" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
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
   ** 完全削除（保険）
===================== */
function sanitize(text) {
  return text.replace(/\*\*/g, "");
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
  console.log("🐻✨ 質問モード起動！");
});
