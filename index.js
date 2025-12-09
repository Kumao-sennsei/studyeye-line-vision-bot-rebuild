// ================================================
// Part1: StudyEye くまお先生ボット - 基礎コア
// （ここは最重要。必ずファイルの最上部に置く）
// ================================================

import express from "express";
import line from "@line/bot-sdk";
import fetch from "node-fetch";

// -----------------------------------------------
// LINE Bot 設定
// -----------------------------------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
app.use(express.json());

// -----------------------------------------------
// ユーザーごとの状態管理（state）
// -----------------------------------------------
const globalState = {}; 
// 格納例：
// globalState[userId] = {
//   mode: "free",
//   exercise: null,
//   lastTopic: null,
//   lastAnswer: null,
// };

// -----------------------------------------------
// 返信ユーティリティ
// -----------------------------------------------
async function replyText(token, text) {
  return client.replyMessage(token, {
    type: "text",
    text,
  });
}

const client = new line.Client(config);

// -----------------------------------------------
// ChatGPT API 呼び出し（基礎版）
// ※ 後で Part2 でくまお先生版に強化する
// -----------------------------------------------
async function askGPT(prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "すみません、返答できませんでした。";
}

// ================================================
// Part1 はここまで！
// ================================================

export { globalState, replyText, askGPT, client };
