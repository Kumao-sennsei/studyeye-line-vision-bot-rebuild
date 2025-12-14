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
state一覧
menu
question_intro
question_waiting
question_explain
lecture
exercise_intro
exercise_question
exercise_answer
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
  if (event.message.type !== "text" && event.message.type !== "image") return;

  const text = event.message.type === "text" ? event.message.text.trim() : "";

  /* ===== 画像質問 ===== */
  if (event.message.type === "image") {
    userState[userId] = { state: "question_waiting", imageId: event.message.id };
    return reply(event.replyToken,
      "解説の品質を最高のものにするために、\n" +
      "この問題の答えがあれば送ってね🐻✨\n" +
      "なければ『答えなし』でOKだよ😊"
    );
  }

  /* ===== メニュー ===== */
  if (!userState[userId] || userState[userId].state === "menu") {
    if (text === "①" || text.includes("講義")) {
      userState[userId] = { state: "lecture" };
      return reply(event.replyToken,
        "まずは大事なところを、\n" +
        "コンパクトにまとめるね🐻✨\n" +
        "ノートにまとめておくといいよ😊"
      );
    }
    if (text === "②" || text.includes("演習")) {
      userState[userId] = { state: "exercise_intro" };
      return reply(event.replyToken,
        "科目と単元を教えてね🐻✨"
      );
    }
    if (text === "③" || text.includes("質問")) {
      userState[userId] = { state: "question_intro" };
      return reply(event.replyToken,
        "解説の品質を最高のものにするために、\n" +
        "先に問題と答えを送ってください🐻✨\n" +
        "テキストでも画像でもいいよ！\n\n" +
        "答えが分かっている場合は、\n" +
        "その答えに合わせて丁寧に解説します😊\n\n" +
        "答えがない場合でも、\n" +
        "解き方や考え方はしっかりお伝えできます！"
      );
    }
    return showMenu(event.replyToken);
  }

  /* ===== 質問：文章 ===== */
  if (userState[userId].state === "question_intro") {
    userState[userId] = { state: "question_explain", question: text };
    const result = await askOpenAI(text);
    return reply(event.replyToken, result);
  }

  /* ===== 演習 ===== */
  if (userState[userId].state === "exercise_intro") {
    userState[userId] = { state: "exercise_question", topic: text };
    return reply(event.replyToken,
      "じゃあ、問題を作るね😊\n" +
      "分からないところは、\n" +
      "無理しなくていいからね🐻✨"
    );
  }

  if (userState[userId].state === "exercise_question") {
    userState[userId] = { state: "exercise_answer", answer: text };
    return reply(event.replyToken,
      "答えを送ってくれてありがとう🐻✨"
    );
  }

  /* ===== 共通フォールバック ===== */
  return showMenu(event.replyToken);
}

/* =====================
   OpenAI 呼び出し
===================== */
async function askOpenAI(userText) {
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
            "あなたはくまお先生です。やさしく明るく説明します。" +
            "アスタリスクや区切り線は出力しません。"
        },
        { role: "user", content: userText }
      ],
    }),
  });

  const json = await res.json();
  return sanitize(json.choices[0].message.content);
}

/* =====================
   出力サニタイズ
===================== */
function sanitize(text) {
  return text
    .replace(/\*/g, "")
    .replace(/_{2,}/g, "")
    .replace(/-{2,}/g, "");
}

/* =====================
   メニュー表示
===================== */
function showMenu(token) {
  return reply(token,
    "次は何をしよっか？🐻✨\n\n" +
    "① 講義を受けたい 📘\n" +
    "② 演習をしたい ✏️\n" +
    "③ 質問がしたい 😊\n" +
    "④ 雑談がしたい ☕"
  );
}

/* =====================
   返信共通
===================== */
function reply(token, text) {
  return client.replyMessage(token, {
    type: "text",
    text,
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
