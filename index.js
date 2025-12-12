/* ======================================================
   くまお先生（B方式：自然会話モード切替）
   Part 1：初期設定・Webhook・モード管理の基礎
====================================================== */

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* ==========================
   環境変数
========================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ==========================
   LINE SDK クライアント
========================== */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ======================================================
   🔥 グローバルでユーザーごとの状態を保存する
   （ユーザーID → currentMode / lectureInfo / practiceInfo etc...）
====================================================== */
const userState = {}; 
// userState[userId] = { mode: "question" | "lecture" | "practice" | "chat", ... }

/* ======================================================
   Webhook 検証・受信
====================================================== */
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
      console.error("Webhook ERROR:", err);
      res.status(200).end();
    }
  }
);

/* ======================================================
   🧠 メインイベント処理
====================================================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  const msg = event.message;

  // ユーザー状態が未登録なら初期化
  if (!userState[userId]) {
    userState[userId] = { mode: "none" };
  }

  const currentMode = userState[userId].mode;

  /* ---------------------------------------------
     画像メッセージは「質問モード扱い」で処理する
  --------------------------------------------- */
  if (msg.type === "image") {
    return handleImageQuestion(event, userId);
  }

  /* ---------------------------------------------
     テキストメッセージ分岐の下地（Part2で完成）
  --------------------------------------------- */
  if (msg.type === "text") {
    const text = msg.text.trim();

    // あいさつは必ず最初に処理
    if (isGreeting(text)) {
      return sendGreetingMenu(event.replyToken);
    }

    // このあと（Part2）で：
    // ・自然会話からモード判定
    // ・質問/講義/演習/雑談 に移行
    // ・モードごとの処理に分岐
  }
}

/* ======================================================
   🐻 あいさつ判定関数（自然文OK）
====================================================== */
function isGreeting(text) {
  return (
    text.includes("こんにちは") ||
    text.includes("こん") ||
    text.includes("はじめまして") ||
    text.includes("やあ") ||
    text.includes("おはよ") ||
    text.includes("こんばんは")
  );
}

/* ======================================================
   🐻 あいさつ時に出すメニュー
====================================================== */
function sendGreetingMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "・質問したい\n" +
      "・講義してほしい\n" +
      "・演習したい\n" +
      "・雑談したい\n\n" +
      "やりたいことをそのまま言ってね！",
  });
}

/* ======================================================
   🧠 画像質問（Vision）への入口
   → 質問モード扱いで即解析
====================================================== */
async function handleImageQuestion(event, userId) {
  userState[userId].mode = "question";

  const base64 = await getImageBase64(event.message.id);

  const instruction =
    "この画像の問題を丁寧に、順番に、くまお先生らしくわかりやすく解説してください。";

  const answer = await callVision(base64, instruction);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: answer,
  });
}

/* ======================================================
   画像取得（Vision用）
====================================================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

/* ======================================================
   Vision API 呼び出し
====================================================== */
async function callVision(imageBase64, instruction) {
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
            "あなたはやさしく寄り添う先生くまお先生です。順番に、かみくだいて説明してください。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

/* ======================================================
   起動
====================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生（B方式）起動中 🐻✨");
});
