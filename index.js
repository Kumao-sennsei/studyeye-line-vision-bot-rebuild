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
   ユーザー状態
===================== */
const userState = {};

/* =====================
   GPTプロンプト定義
===================== */

const BASE_RULE_PROMPT = `
【表記ルール（必ず守ること）】

const BASE_RULE_PROMPT = `
【表記ルール（必ず守ること）】

・LINE上で表示されることを前提とする
・Markdown記法は禁止
（**、__、##、--- などは使わない）
・LaTeX記法は禁止
（\\frac、\\[ \\] など使わない）
・仕切り線（--- や ――）は使わない

【数式・記号について】
・数式はすべてプレーンテキストで書く
・使用してよい記号：
　√、√2、×、÷、＝、＋、－
・指数は上付き文字を使ってよい
　例：10²³ 個、m²、cm³
・最低限の数式で、読みやすさを最優先する

【番号表記ルール（厳守）】
・行動選択・メニューは ①②③④ を使う
・解き方の手順は必ず 1⃣ 2⃣ 3⃣ を使う
・解説では ①②③ を使わない
（共通テストなどの設問番号と混同を防ぐため）

【あいさつ文言の固定】
・最初のあいさつは必ず次の文言を使う
「こんにちは🐻✨

今日は何をする？
① 質問がしたい😊
② 講義を受けたい📘
③ 演習（類題）をしたい✏️
④ 雑談がしたい💬」

・上記の文言は変更しない
・余計な説明文を追加しない

・図やグラフが必要な場合は、文章で状況を説明する
`;


const QUESTION_TEMPLATE_PROMPT = `
くまお先生です！やさしく解説するね🐻✨

【問題の要点】

【解き方】
①
②
③

【解説】

【答え】
・単語や数値は必ず明示
・記述問題は正答例を1つ示す

ほかに聞きたい？
それともこの問題の類題を解いてみる？
`;

const QUESTION_SYSTEM_PROMPT =
  BASE_RULE_PROMPT + QUESTION_TEMPLATE_PROMPT;

const EXERCISE_RULE_PROMPT = `
【類題作成ルール】

・直前の問題と同じ「問題の型」を必ず維持する
・構造や解き方は変えない
・数値や条件のみ変更する
・類題には必ず【答え】をつける（解説は簡潔でよい）
`;

const EXERCISE_SYSTEM_PROMPT =
  BASE_RULE_PROMPT + EXERCISE_RULE_PROMPT;

/* =====================
   Vision用プロンプト
===================== */

const VISION_RULE_PROMPT = `
【画像問題の読み取りルール】

・画像内の文章、数式、図を丁寧に読み取る
・不鮮明な部分は文脈から判断する
・途中まででも必ず説明を行う
`;

const VISION_TEMPLATE_PROMPT = `
くまお先生です！やさしく解説するね🐻✨

【問題の要点】

【解き方】
① 画像の条件を整理
② 必要な知識を確認
③ 順に考える

【解説】

【答え】
・数値や語句は明確に
・記述は正答例を1つ示す

ほかに聞きたい？
それともこの問題の類題を解いてみる？
`;

const VISION_SYSTEM_PROMPT =
  BASE_RULE_PROMPT +
  VISION_RULE_PROMPT +
  VISION_TEMPLATE_PROMPT;

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
    } catch (e) {
      console.error(e);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* 画像 */
  if (event.message?.type === "image") {
    const base64 = await getImageBase64(event.message.id);
    const result = await runVisionQuestionMode(base64);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* テキスト */
  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  if (text === "①" || text.includes("質問")) {
    userState[userId] = { mode: "question" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章でも画像でも質問してね😊",
    });
  }

  if (text.includes("類題")) {
    userState[userId] = { mode: "exercise" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "いいね🐻✨\n" +
        "同じ型の類題を出すよ！",
    });
  }

  if (userState[userId]?.mode === "exercise") {
    const result = await runExerciseMode(text);
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  const result = await runQuestionMode(text);
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: result,
  });
}

/* =====================
   GPT呼び出し
===================== */

async function runQuestionMode(text) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
}

async function runExerciseMode(text) {
  return callOpenAI([
    { role: "system", content: EXERCISE_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
}

async function runVisionQuestionMode(imageBase64) {
  return callOpenAI([
    { role: "system", content: VISION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: "この画像の問題を読み取って解説してください。" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

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
    }),
  });
  const json = await res.json();
  return json.choices[0].message.content;
}

/* =====================
   画像取得
===================== */
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

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 起動しました！");
});
