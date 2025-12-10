import express from "express";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

/* =========================
   環境変数
========================= */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* =========================
   Webhook
========================= */
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
    // ✅ 先に200を返す（超重要）
    res.status(200).end();

    try {
      for (const event of req.body.events) {
        await handleEvent(event);
      }
    } catch (e) {
      console.error(e);
    }
  }
);

/* =========================
   メイン処理
========================= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  // テキスト
  if (event.message.type === "text") {
    await client.replyMessage(event.replyToken, {
      type: "template",
      altText: "メニュー",
      template: {
        type: "buttons",
        title: "こんにちは🐻✨",
        text: "今日は何をする？",
        actions: [
          { type: "message", label: "① 質問がしたい", text: "質問" },
          { type: "message", label: "② 講義を受けたい", text: "講義" },
          { type: "message", label: "③ 演習がしたい", text: "演習" },
          { type: "message", label: "④ 雑談したい", text: "雑談" },
        ],
      },
    });
  }
}

/* =========================
   起動
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
