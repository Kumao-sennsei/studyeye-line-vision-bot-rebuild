import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

// ==============================
// 環境変数
// ==============================
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ==============================
// Webhook（最重要）
// ==============================
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
  (req, res) => {
    // ✅ 何があっても即200返す
    res.status(200).end();

    // ✅ あとで処理（非同期）
    req.body.events.forEach(handleEvent);
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  // ------------------------------
  // テキスト
  // ------------------------------
  if (event.message.type === "text") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "こんにちは🐻✨\n\n" +
        "今日は何をする？\n\n" +
        "① 質問がしたい\n" +
        "② 講義を受けたい\n" +
        "③ 演習がしたい\n" +
        "④ 雑談したい\n\n" +
        "画像の問題も送ってOKだよ📸",
    });
  }

  // ------------------------------
  // 画像（今はテスト返信だけ）
  // ------------------------------
  if (event.message.type === "image") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像ありがとう🐻✨\n" +
        "今からこの問題をやさしく解説するね！\n\n" +
        "（※ 次のステップでAI解説をつなぐよ）",
    });
  }
}

// ==============================
app.listen(3000, () => {
  console.log("✅ くまお先生 起動中 🐻✨");
});
