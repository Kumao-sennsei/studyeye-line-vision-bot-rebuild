import express from "express";
import { Client } from "@line/bot-sdk";

const app = express();

// ==============================
// 環境変数
// ==============================
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ==============================
// Webhook
// ==============================
app.post(
  "/webhook",
  // ✅ 署名検証なしの素の JSON パーサー
  express.json(),
  async (req, res) => {
    // ✅ 先に 200 を返しておく（タイムアウト防止）
    res.status(200).end();

    try {
      if (!req.body || !req.body.events) {
        console.log("No events in body");
        return;
      }

      for (const event of req.body.events) {
        handleEvent(event).catch(console.error);
      }
    } catch (err) {
      console.error("handleEvent error:", err);
    }
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  console.log("Incoming event:", JSON.stringify(event));

  if (event.type !== "message") return;

  // 画像は今は「テスト中です」とだけ返す
  if (event.message.type === "image") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "画像ありがとう🐻✨ 今はボタン動作のテスト中だよ！",
    });
    return;
  }

  // テキストには必ずメニューを返す
  if (event.message.type === "text") {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "こんにちは🐻✨\n\n" +
        "今日は何をする？\n" +
        "下のボタンからえらんでね👇",
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "message",
              label: "質問がしたい ✏️",
              text: "質問がしたい",
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "講義を受けたい 📘",
              text: "講義を受けたい",
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "演習がしたい 📝",
              text: "演習がしたい",
            },
          },
          {
            type: "action",
            action: {
              type: "message",
              label: "雑談したい ☕",
              text: "雑談したい",
            },
          },
        ],
      },
    });
  }
}

// ==============================
app.listen(3000, () => {
  console.log("くまお先生（ボタンテスト版） 起動中 🐻✨");
});
