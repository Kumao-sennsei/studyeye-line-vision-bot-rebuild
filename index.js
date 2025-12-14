import express from "express";
import { Client } from "@line/bot-sdk";

const app = express();

/* ========= 環境変数 ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

/* ========= 状態管理（超重要） ========= */
/*
state例:
menu
lecture_wait_topic
lecture_running
question_wait_problem
*/
const userState = new Map();

/* ========= メニュー文言（固定・変更禁止） ========= */
const MAIN_MENU_TEXT =
`次は何をしよっか？🐻✨
① 講義を受けたい 📘
② 演習をしたい ✏️
③ 質問がしたい 😊
④ 雑談がしたい ☕`;

/* ========= Webhook ========= */
app.post("/webhook", express.json(), async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === "message") {
        await handleMessage(event);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/* ========= メッセージ処理 ========= */
async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text?.trim();

  // 初期状態
  if (!userState.has(userId)) {
    userState.set(userId, "menu");
  }

  const state = userState.get(userId);

  /* ===== あいさつ → メニュー ===== */
  if (text === "こんにちは") {
    userState.set(userId, "menu");
    return replyText(event, MAIN_MENU_TEXT);
  }

  /* ===== メニュー処理 ===== */
  if (state === "menu") {
    if (text === "①" || text.includes("講義")) {
      userState.set(userId, "lecture_wait_topic");
      return replyText(
        event,
        "いいね😊\n受けたい講義の\n科目と単元を教えてね🐻✨\n\n例）化学 酸化還元反応"
      );
    }

    if (text === "③" || text.includes("質問")) {
      userState.set(userId, "question_wait_problem");
      return replyText(
        event,
        `解説の品質を最高のものにするために、
先に問題と答えを送ってください🐻✨
テキストでも画像でもいいよ！

答えが分かっている場合は、
その答えに合わせて丁寧に解説します😊

答えがない場合でも、
解き方や考え方はしっかりお伝えできます！`
      );
    }

    return replyText(event, MAIN_MENU_TEXT);
  }

  /* ===== 講義ルート ===== */
  if (state === "lecture_wait_topic") {
    userState.set(userId, "lecture_running");
    return replyText(
      event,
      `ありがとう😊
「${text}」だね！

じゃあ、講義を始めていくね🐻✨
大事なところはノートにまとめておくと復習しやすいよ😊`
    );
  }

  /* ===== 質問ルート ===== */
  if (state === "question_wait_problem") {
    // ここではまだ解説しない（安全）
    userState.set(userId, "menu");
    return replyText(
      event,
      "問題を送ってくれてありがとう😊\n\nこのあと、必要に応じて丁寧に解説するね🐻✨\n\n" +
      MAIN_MENU_TEXT
    );
  }
}

/* ========= 返信関数 ========= */
function replyText(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

/* ========= 起動 ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Kumao-sensei is running 🐻✨");
});
