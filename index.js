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

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* =====================
   Webhook（最重要）
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
    // ✅ まず即200返す（タイムアウト防止）
    res.status(200).end();

    // ✅ あとは非同期で処理
    try {
      await Promise.all(req.body.events.map(handleEvent));
    } catch (err) {
      console.error("handleEvent error:", err);
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  /* ---------- テキスト ---------- */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 初回 or 何でもいい入力
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "こんにちは😊🐻\n今日は何をする？",
      quickReply: {
        items: [
          button("質問がしたい", "質問"),
          button("講義を受けたい", "講義"),
          button("演習がしたい", "演習"),
          button("雑談したい", "雑談"),
        ],
      },
    });
  }

  /* ---------- 画像 ---------- */
  if (event.message.type === "image") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像ありがとう🐻✨\n\n" +
        "この問題、\n" +
        "✅ そのまま解説\n" +
        "✅ 自分の答えを送って採点\n\n" +
        "どっちにする？",
    });
  }
}

/* =====================
   ボタン生成
===================== */
function button(label, text) {
  return {
    type: "action",
    action: {
      type: "message",
      label,
      text,
    },
  };
}

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
