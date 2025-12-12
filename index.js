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
      res.status(200).end(); // ← これがないと 502 エラーになる
    } catch (err) {
      console.error(err);
      res.status(200).end(); // ← 失敗しても必ず200返す
    }
  }
);

/* =====================
  メイン処理（メニュー → ①②③④）
===================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* ---------- 初回メニュー ---------- */
    if (
      text === "こんにちは" ||
      text === "はじめまして" ||
      text === "メニュー"
    ) {
      return replyMenu(event.replyToken);
    }

    /* ---------- ① 質問 ---------- */
    if (text.startsWith("①")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね！質問モードだよ🐻✨\n\n" +
          "・問題文を送る\n" +
          "・写真を送る\n" +
          "・文章で質問する\n\n" +
          "好きな形で送ってね！",
      });
    }

    /* ---------- ② 講義 ---------- */
    if (text.startsWith("②")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "了解！講義モード📘✨\n\n" +
          "🔸 教科（例：数学、物理、化学）\n" +
          "🔸 単元（例：2次関数、電磁気、酸化還元）\n\n" +
          "この2つを教えてね！",
      });
    }

    /* ---------- 科目＋単元が送られてきたら講義開始 ---------- */
    if (text.includes(" ") && text.split(" ").length === 2) {
      const [subject, unit] = text.split(" ");

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `了解！講義を始めるよ📘✨\n\n` +
          `【教科】${subject}\n【単元】${unit}\n\n` +
          `まずは基礎から説明するね。\n（ここに後で本物の講義ロジックを入れる）`,
      });
    }

    /* ---------- ③ 演習 ---------- */
    if (text.startsWith("③")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "演習モードだね🔥📝\n\n" +
          "🔸 教科（数学 / 物理 / 化学 など）\n" +
          "🔸 レベル（基礎 / 標準 / 難関）\n\n" +
          "この2つを教えてくれたら問題を出すね！",
      });
    }

    /* ----- 演習の形式： '数学 基礎' のような2語 ----- */
    if (text.includes(" ") && text.split(" ").length === 2) {
      const [subject, level] = text.split(" ");

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `OK！演習モード開始🔥\n\n` +
          `【教科】${subject}\n【レベル】${level}\n\n` +
          `第1問いくよ！\n（ここに後で演習問題ロジックを入れる）`,
      });
    }

    /* ---------- ④ 雑談 ---------- */
    if (text.startsWith("④")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "雑談モードだよ☕✨\n\nなんでも話してね！",
      });
    }

    /* ---------- どれでもない → メニュー ---------- */
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
