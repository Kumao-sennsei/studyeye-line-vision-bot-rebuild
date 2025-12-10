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

// ------------------------------
// テキストメッセージ（ボタン導線）
// ------------------------------
if (event.message.type === "text") {
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "こんにちは😊🐻\n\n今日は何をする？\nえらんでね👇",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "message",
            label: "① 質問がしたい ✏️",
            text: "質問がしたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "② 講義を受けたい 📘",
            text: "講義を受けたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "③ 演習がしたい 📝",
            text: "演習がしたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "④ 雑談したい ☕",
            text: "雑談したい"
          }
        }
      ]
    }
  });
  return;
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
