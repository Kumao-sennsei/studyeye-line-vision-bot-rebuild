import express from "express";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

// ==============================
// 環境変数
// ==============================
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// ==============================
// LINE Client
// ==============================
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ==============================
// Webhook
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
  async (req, res) => {
    try {
      const events = req.body.events || [];
      for (const event of events) {
        await handleEvent(event);
      }
      // ★ 絶対に 200 を返す
      res.status(200).end();
    } catch (err) {
      console.error("Webhook error:", err);
      // ★ エラーでも 200 を返す（超重要）
      res.status(200).end();
    }
  }
);

// ==============================
// イベント処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  // テキストだけ処理
  if (event.message.type === "text") {
    const userText = event.message.text;

    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "こんにちは🐻✨\n\n" +
        "ちゃんと届いてるよ！\n\n" +
        "今はテスト中だから、\n" +
        "この返信が来れば成功です🙆‍♂️\n\n" +
        "送ってくれた内容👇\n" +
        `「${userText}」`,
    });
  }
}

// ==============================
// ヘルスチェック
// ==============================
app.get("/", (req, res) => {
  res.send("Kumao Bot running 🐻✨");
});

// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 Step3 起動中 🐻✨");
});
