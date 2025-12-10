import express from "express";
import crypto from "crypto";
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
// Webhook (署名検証付き)
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
        console.error("❌ 署名エラー");
        throw new Error("Invalid signature");
      }
    },
  }),
  async (req, res) => {
    try {
      const events = req.body.events;

      for (const event of events) {
        await handleEvent(event);
      }

      res.status(200).send("OK");
    } catch (e) {
      console.error("## ERROR ##", e);
      res.status(200).send("OK"); // ← 絶対に200を返す（502対策）
    }
  }
);

// ==============================
// イベント処理（エコーするだけ）
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  if (event.message.type === "text") {
    const text = event.message.text;

    // そのまま返す
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `Echo: ${text}`,
    });
  }
}

// ==============================
app.listen(3000, () => {
  console.log("🔥 安定版くまお先生 起動中（Echoモード）");
});
