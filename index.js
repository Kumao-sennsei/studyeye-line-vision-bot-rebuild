import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* =====================
   環境変数
===================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* =====================
   LINE クライアント
===================== */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* =====================
   表示文言（ULTIMATE）
===================== */
const COPY = {
  MENU:
    "じゃあ次は何しよっか？🐻✨\n" +
    "① 質問がしたい\n" +
    "② 講義を受けたい\n" +
    "③ 演習（類題）をしたい\n" +
    "④ 雑談がしたい",

  QUESTION_START:
    "質問モードだよ🐻✨\n" +
    "文章で質問してもいいし、問題の写真を送ってもOKだよ😊",

  IMAGE_RECEIVED:
    "画像を受け取ったよ🐻✨\n\n" +
    "この問題の公式の答えがあれば送ってね。\n" +
    "なければ「答えなし」で大丈夫だよ😊",

  AFTER_QUESTION:
    "ほかに聞きたい？それともこの問題の類題を解いてみる？",

  PRACTICE_GUIDE:
    "いいね🐻✨\n\n" +
    "じゃあ類題を作るよ。\n" +
    "次の3つを教えてね😊\n" +
    "① 単元\n" +
    "② 問題のタイプ\n" +
    "③ むずかしさ\n\n" +
    "※「さっきの問題と同じで、数値だけ変えて」でもOK",

  ANSWER_ONLY: "答えだけ送っても大丈夫だよ😊",

  PRAISE:
    "すごい！正解だよ🐻✨\n" +
    "ちゃんと理解できてる証拠だね😊",

  EXPLAIN_INTRO:
    "だいじょうぶだよ😊\n" +
    "ここは少し難しかったね。\n\n" +
    "まずは、この問題の考え方を\n" +
    "解説でいっしょに整理しよう🐻✨",

  LECTURE_CONFIRM:
    "この単元、講義で復習しよっか？🐻✨\n" +
    "・はい\n" +
    "・いいえ",

  THANKS_REPLY:
    "こちらこそ、ありがとう😊\n\n",
};

/* =====================
   ユーザー状態
===================== */
const userState = {};
/*
mode:
menu
question
image_wait
after_question
practice_condition
practice_answer
practice_explanation
lecture_confirm
lecture
*/

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
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!userState[userId]) userState[userId] = { mode: "menu" };

  /* ===== 画像 ===== */
  if (event.message?.type === "image") {
    userState[userId] = { mode: "image_wait", imageId: event.message.id };
    return reply(event.replyToken, COPY.IMAGE_RECEIVED);
  }

  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* ===== 感想・お礼検知 ===== */
  if (
    text.includes("ありがとう") ||
    text.includes("ありがと") ||
    text.includes("助かった") ||
    text.includes("OK") ||
    text.includes("了解")
  ) {
    userState[userId].mode = "menu";
    return reply(
      event.replyToken,
      COPY.THANKS_REPLY + COPY.MENU
    );
  }

  /* ===== メニュー ===== */
  if (userState[userId].mode === "menu") {
    if (text.startsWith("①")) {
      userState[userId].mode = "question";
      return reply(event.replyToken, COPY.QUESTION_START);
    }
    if (text.startsWith("③")) {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_GUIDE);
    }
    return reply(event.replyToken, COPY.MENU);
  }

  /* ===== 画像質問 ===== */
  if (userState[userId].mode === "image_wait") {
    const base64 = await getImageBase64(userState[userId].imageId);
    const result = await runVisionQuestionMode(
      base64,
      text === "答えなし" ? null : text
    );
    userState[userId].mode = "after_question";
    return reply(event.replyToken, result);
  }

  /* ===== 文章質問 ===== */
  if (userState[userId].mode === "question") {
    const result = await runTextQuestionMode(text);
    userState[userId].mode = "after_question";
    return reply(event.replyToken, result);
  }

  /* ===== after_question ===== */
  if (userState[userId].mode === "after_question") {
    if (text.includes("類題")) {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_GUIDE);
    }
    userState[userId].mode = "question";
    return reply(event.replyToken, COPY.QUESTION_START);
  }

  /* ===== 類題条件 ===== */
  if (userState[userId].mode === "practice_condition") {
    const question = await generateExercise(text);
    userState[userId].mode = "practice_answer";
    userState[userId].exerciseQuestion = question;
    return reply(
      event.replyToken,
      "【類題】\n" + question + "\n\n" + COPY.ANSWER_ONLY
    );
  }

  /* ===== 類題解答 ===== */
  if (userState[userId].mode === "practice_answer") {
    if (text.includes("わから")) {
      userState[userId].mode = "practice_explanation";
      return reply(event.replyToken, COPY.EXPLAIN_INTRO);
    }
    const judge = await judgeAnswer(
      userState[userId].exerciseQuestion,
      text
    );
    if (judge === "正解") {
      userState[userId].mode = "after_question";
      return reply(
        event.replyToken,
        COPY.PRAISE + "\n\n" + COPY.AFTER_QUESTION
      );
    }
    userState[userId].mode = "practice_explanation";
    return reply(event.replyToken, COPY.EXPLAIN_INTRO);
  }

  /* ===== 類題 解説 ===== */
  if (userState[userId].mode === "practice_explanation") {
    const result = await runTextQuestionMode(
      userState[userId].exerciseQuestion
    );
    userState[userId].mode = "lecture_confirm";
    return reply(event.replyToken, result);
  }

  /* ===== 講義確認 ===== */
  if (userState[userId].mode === "lecture_confirm") {
    if (text.includes("はい")) {
      userState[userId].mode = "lecture";
      return reply(
        event.replyToken,
        "よしっ😊\nじゃあ講義で復習しよう🐻✨"
      );
    }
    userState[userId].mode = "menu";
    return reply(
      event.replyToken,
      "OK😊\n\n" + COPY.MENU
    );
  }

  /* ===== 講義 ===== */
  if (userState[userId].mode === "lecture") {
    userState[userId].mode = "menu";
    return reply(
      event.replyToken,
      "🐻✨ くまお先生の講義\n\n" +
        "この単元を、教科書レベルで\n" +
        "ていねいに整理して説明するよ📘\n\n" +
        COPY.MENU
    );
  }
}

/* =====================
   GPT 呼び出し（解説テンプレ固定）
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」です。
以下のテンプレートを【完全に厳守】してください。
【表記ルール（必ず守ること）】

・LINE上で表示されることを前提とする
・Markdown記法は禁止
　（**、__、##、---、箇条書きの装飾などは使わない）
・LaTeX記法は禁止
　（\frac、\[ \]、数式コマンドは使わない）
・仕切り線（--- や ――）は使わない

【数式・記号について】
・数式はすべてプレーンテキストで書く
・使用してよい記号：
　√、√2、×、÷、＝、＋、－
・指数は上付き文字を使ってよい
　例：10²³ 個、m²、cm³
・「10の23乗」のような表現も可

・最低限の数式で、読みやすさを最優先する
・図やグラフが必要な場合は、文章で状況を説明する
くまお先生です！やさしく解説するね🐻✨

【問題の要点】
この問題は〜〜を求める問題だよ！

【解き方】
①
②
③

【解説】
順番に説明するね😊
途中の考え方が大事だよ！

【答え】
・単語や数値の答えは必ずはっきり書く
・記述問題の場合は「正答例」を1つ必ず示す

ほかに聞きたい？
それともこの問題の類題を解いてみる？
【類題作成ルール】

・直前の問題と同じ「問題の型」を必ず維持する
・問題の構造、聞き方、解き方は変えない
・数値・条件・人物など、指定された部分のみを変更する

・生徒が
　「さっきの問題で数値を変えて」
　「同じ問題で条件だけ変えて」
　と言った場合も、必ず同型問題を作る

・類題には必ず【答え】もつける
　（解説は簡潔でよい）
【内部用】
類題を作るときは、直前の問題について次を意識すること。

・教科
・問題の型（例：物質量→原子の数を求める計算）
・解く手順（例：nを求めてから定数をかける）

これらを維持したまま類題を作る。


く  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

async function runVisionQuestionMode(imageBase64, answer) {
  return runTextQuestionMode("画像の問題");
}

/* =====================
   GPT共通
===================== */
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages,
      temperature: 0.2,
    }),
  });
  const json = await res.json();
  return json.choices[0].message.content;
}

async function generateExercise(condition) {
  return callOpenAI([
    {
      role: "system",
      content:
        "問題文のみを1問作成してください。答え・解説は禁止。",
    },
    { role: "user", content: condition },
  ]);
}

async function judgeAnswer(q, a) {
  const res = await callOpenAI([
    {
      role: "system",
      content:
        "正しければ「正解」、違えば「不正解」だけを書いてください。",
    },
    { role: "user", content: `問題:${q}\n答え:${a}` },
  ]);
  return res.includes("正解") ? "正解" : "不正解";
}

async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

function reply(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ くまお先生 BOT ULTIMATE 起動！");
});
