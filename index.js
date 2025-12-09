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

// ================================================
// Part2: イベント受信ルーター（基礎版）
// ================================================

// LINE Webhook エンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;

    // 応答しないとLINE側がタイムアウト扱いになるので先に返す
    res.status(200).send("OK");

    // 各イベントを処理
    for (const event of events) {
      await handleEvent(event);
    }

  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

// -----------------------------------------------
// イベント処理本体（基礎モード）
// -----------------------------------------------
async function handleEvent(event) {
  // ユーザーID
  const userId = event.source.userId;

  // state 初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null,
    };
  }

  const state = globalState[userId];

  // -------------------------------------------
  // 画像メッセージは「今はまだ未対応 → 返答」
  // 後で Part3 で Vision を追加する！
  // -------------------------------------------
  if (event.type === "message" && event.message.type === "image") {
    return replyText(event.replyToken, "🐻💡 画像を受け取ったよ！この機能は今準備中なんだ。もう少し待っててね！");
  }

  // -------------------------------------------
  // テキストメッセージ
  // -------------------------------------------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // メニュー呼び出し
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      return replyText(event.replyToken, "🐻📖 メニューだよ！今は「フリーモード」で話せるよ〜");
    }

    // Freeモードの通常会話
    return await handleFreeMode(event, state);
  }
}

// -----------------------------------------------
// Freeモードの会話処理
// -----------------------------------------------
async function handleFreeMode(event, state) {
  const userMessage = event.message.text.trim();

  const prompt = `
あなたは「くまお先生」です。かわいく優しく、高校生に教えるように返答します。
語尾に「🐻」を自然に混ぜてもOK。

ユーザー: ${userMessage}
  `;

  const reply = await askGPT(prompt);

  return replyText(event.replyToken, reply);
}

