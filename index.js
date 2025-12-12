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

// ---- 簡易メモリ（本当は DB 推奨） ----
const userState = {};   // userId → { mode: "question" | "lecture" | "exercise" | "chat" }

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
      res.status(200).end();
    } catch (err) {
      console.error(err);
      res.status(200).end();
    }
  }
);

/* =====================
  メイン処理
===================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  if (!userState[userId]) userState[userId] = { mode: null };

  const mode = userState[userId].mode;
  const text = event.message.text.trim();

  /* ====== メニュー表示ワード ====== */
  if (["こんにちは", "メニュー", "はじめまして"].includes(text)) {
    userState[userId].mode = null;
    return replyMenu(event.replyToken);
  }

  /* ====== ① 質問モード ====== */
  if (text.startsWith("①")) {
    userState[userId].mode = "question";

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

  // 質問 → AI に質問を渡して解説させる（後で Vision も追加できる）
  if (mode === "question") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `その質問に答えるね✨\n\n（ここに OpenAI の回答を later で追加）\n\nあなたの質問：${text}`,
    });
  }

  /* ====== ② 講義モード ====== */
  if (text.startsWith("②")) {
    userState[userId].mode = "lecture";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "了解！講義モード📘✨\n\n" +
        "🔸 教科（例：数学、物理、化学）\n" +
        "🔸 単元（例：2次関数、電磁気、酸化還元）\n\n" +
        "この2つをスペース区切りで送ってね！\n例）数学 2次関数",
    });
  }

  if (mode === "lecture" && text.includes(" ")) {
    const [subject, unit] = text.split(" ");

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `講義を始めるよ📘✨\n\n` +
        `【教科】${subject}\n【単元】${unit}\n\n` +
        `まずは基礎から説明するね！\n（ここに講義ロジックを追加予定）`,
    });
  }

  /* ====== ③ 演習モード ====== */
  if (text.startsWith("③")) {
    userState[userId].mode = "exercise";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "演習モードだね🔥📝\n\n" +
        "🔸 教科（数学 / 物理 / 化学 など）\n" +
        "🔸 レベル（基礎 / 標準 / 難関）\n\n" +
        "例）数学 基礎",
    });
  }

  if (mode === "exercise" && text.includes(" ")) {
    const [subject, level] = text.split(" ");

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `OK！演習開始🔥\n\n` +
        `【教科】${subject}\n【レベル】${level}\n\n` +
        `第1問いくよ！\n（ここで後で問題を出す機能を入れる）`,
    });
  }

  /* ====== ④ 雑談 ====== */
  if (text.startsWith("④")) {
    userState[userId].mode = "chat";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "雑談モードだよ☕✨\n\nなんでも話してね！",
    });
  }

  if (mode === "chat") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `いいね、その話もっと聞かせて☕✨\n\n→ ${text}`,
    });
  }

  /* ====== どれでもなければメニュー ====== */
  return replyMenu(event.replyToken);
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
