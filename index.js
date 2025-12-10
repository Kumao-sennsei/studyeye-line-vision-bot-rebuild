import express from "express";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

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
    res.status(200).end(); // ★ 最優先：即200
    for (const event of req.body.events) {
      handleEvent(event).catch(console.error);
    }
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  if (event.message.type === "text") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "こんにちは🐻✨\n\n" +
        "今日は何をする？\n" +
        "下からえらんでね👇",
      quickReply: {
        items: [
          {
            type: "action",
            action: { type: "message", label: "質問がしたい ✏️", text: "質問がしたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "講義を受けたい 📘", text: "講義を受けたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "演習がしたい 📝", text: "演習がしたい" },
          },
          {
            type: "action",
            action: { type: "message", label: "雑談したい ☕", text: "雑談したい" },
          },
        ],
      },
    });
  }
}

// ==============================
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
