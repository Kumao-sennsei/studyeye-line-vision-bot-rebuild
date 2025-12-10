import express from "express";
import crypto from "crypto";
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
  Webhook
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
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end(); // ← 502防止の最重要ポイント
    } catch (err) {
      console.error(err);
      res.status(200).end(); // ← LINEには必ず200を返す
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

    // 初回 or こんにちは
    if (text === "こんにちは" || text === "はじめまして") {
      return replyMenu(event.replyToken);
    }

    // ① 質問
    if (text.startsWith("①")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね！質問だね🐻✨\n\n" +
          "・問題文を送る\n" +
          "・写真を送る\n" +
          "・文章で質問\n\n" +
          "どれでもOKだよ！",
      });
    }

    // ② 講義
    if (text.startsWith("②")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "了解！講義モード📘✨\n\n" +
          "・教科（数学・物理・化学など）\n" +
          "・単元（例：2次関数、微分）\n\n" +
          "を教えてね！",
      });
    }

    // ③ 演習
    if (text.startsWith("③")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "演習モードだね📝🔥\n\n" +
          "・教科\n" +
          "・レベル（基礎〜難関）\n\n" +
          "を教えてくれたら問題を出すよ！",
      });
    }

    // その他
    return replyMenu(event.replyToken);
  }
}

/* =====================
  メニュー返信
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習がしたい 📝\n" +
      "④ 雑談したい ☕",
  });
}

/* =====================
  起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
