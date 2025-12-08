// ================================================
// Part1: 基本セットアップ（LINE × OpenAI）
// ================================================
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
require("dotenv").config();

const app = express();

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ユーザー状態（FREEモード1本）
const globalState = {};

// ヘルスチェック
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

// Webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

// サーバー起動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running:", port));

// ================================================
// Part2: OpenAI 共通処理（壊れない超シンプル版）
// ================================================
async function callOpenAI(messages) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",     // 軽くて速い
        temperature: 0.4,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return res.data.choices?.[0]?.message?.content || "返事が読み取れなかったよ💦";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "OpenAIとの通信でエラーが発生しちゃったよ🐻💦";
  }
}

// ================================================
// Part3: FREEモードのイベントルーター（超シンプル）
// ================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // ユーザー状態がなければ初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      lastAnswer: null,
      lastTopic: null,
    };
  }

  const state = globalState[userId];

  // 画像メッセージ → 数学/物理/化学の問題解析へ
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  // テキストメッセージ
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // 強制メニューコマンド（どのモードでも発動）
    if (text === "メニュー") {
      state.mode = "free";
      state.lastTopic = null;
      state.lastAnswer = null;
      return replyMenu(event.replyToken);
    }

    // 通常の FREE 対話処理
    return handleFreeText(event, state);
  }

  // その他（スタンプ等）
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨",
  });
}

