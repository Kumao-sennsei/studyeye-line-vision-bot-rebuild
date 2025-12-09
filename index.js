// ================================================
// Part1: StudyEye くまお先生ボット - 基礎コア
// （ここは最重要。必ずファイルの最上部に置く）
// ================================================

import express from "express";
import line from "@line/bot-sdk";
import fetch from "node-fetch";

// -----------------------------------------------
// LINE Bot 設定
// -----------------------------------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
app.use(express.json());

// -----------------------------------------------
// ユーザーごとの状態管理（state）
// -----------------------------------------------
const globalState = {}; 
// 格納例：
// globalState[userId] = {
//   mode: "free",
//   exercise: null,
//   lastTopic: null,
//   lastAnswer: null,
// };

// -----------------------------------------------
// 返信ユーティリティ
// -----------------------------------------------
async function replyText(token, text) {
  return client.replyMessage(token, {
    type: "text",
    text,
  });
}

const client = new line.Client(config);

// -----------------------------------------------
// ChatGPT API 呼び出し（基礎版）
// ※ 後で Part2 でくまお先生版に強化する
// -----------------------------------------------
async function askGPT(prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "すみません、返答できませんでした。";
}

// ================================================
// Part1 はここまで！
// ================================================

export { globalState, replyText, askGPT, client };

// ================================================
// Part2: イベント受信ルーター（基礎版）
// ================================================

// LINE Webhook エンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;

    // 応答しないとLINE側がタイムアウト扱いになるので先に返す
    res.status(200).send("OK");

    // 各イベントを処理
    for (const event of events) {
      await handleEvent(event);
    }

  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

// -----------------------------------------------
// イベント処理本体（基礎モード）
// -----------------------------------------------
async function handleEvent(event) {
  // ユーザーID
  const userId = event.source.userId;

  // state 初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null,
    };
  }

  const state = globalState[userId];

  // -------------------------------------------
  // 画像メッセージは「今はまだ未対応 → 返答」
  // 後で Part3 で Vision を追加する！
  // -------------------------------------------
  if (event.type === "message" && event.message.type === "image") {
    return replyText(event.replyToken, "🐻💡 画像を受け取ったよ！この機能は今準備中なんだ。もう少し待っててね！");
  }

  // -------------------------------------------
  // テキストメッセージ
  // -------------------------------------------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // メニュー呼び出し
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      return replyText(event.replyToken, "🐻📖 メニューだよ！今は「フリーモード」で話せるよ〜");
    }

    // Freeモードの通常会話
    return await handleFreeMode(event, state);
  }
}

// -----------------------------------------------
// Freeモードの会話処理
// -----------------------------------------------
async function handleFreeMode(event, state) {
  const userMessage = event.message.text.trim();

  const prompt = `
あなたは「くまお先生」です。かわいく優しく、高校生に教えるように返答します。
語尾に「🐻」を自然に混ぜてもOK。

ユーザー: ${userMessage}
  `;

  const reply = await askGPT(prompt);

  return replyText(event.replyToken, reply);
}

// =========================================================
// Part3: FREEモードのイベントルーター（完全正常版）
// =========================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // ユーザーステート初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null
    };
  }

  const state = globalState[userId];

  // ----------------------------------------------------
  // 画像 → 画像解析へ
  // ----------------------------------------------------
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event, state);
  }

  // ----------------------------------------------------
  // テキスト
  // ----------------------------------------------------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // Part3：答え付き画像ルーター（テキストで答えが届いたとき判定する用）
    if (await routeImageIfNeeded(event, state)) {
      return;
    }

    // メニュー
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      return replyMenu(event.replyToken);
    }

    // 演習モード中（回答の判定へ）
    if (state.exercise && state.exercise.step === 1) {
      return handleExerciseMode(event, state);
    }

    // 通常の FREE 対話
    return handleFreeText(event, state);
  }
}


// =====================================================
// Part4: 授業モード（板書ノート & 深掘り）
// =====================================================

// 生徒が「授業して」などと言ったときに使う（任意）
async function generateLectureNote(topic, level = "normal") {
  const prompt = `
あなたは優しく丁寧に教える「くまお先生」です。

【目的】
生徒がノートに写したくなるような “板書スタイル” の講義ノートを作る。

【ルール】
・ChatGPTっぽいMarkdown記号（#, *, **, --- など）禁止
・絵文字は使わない（ノートはすっきり）
・短い見出しを入れてまとめる
・途中式は LINE で読める形式：(a)/(b), √(a), a^2 など
・専門用語はやさしく補足する
・最後に「今日のまとめ！」「ここがポイント！」の2セクションを必ず作る
・必要なら「間違いやすいところ」も入れる
・口調は黒板に書きながら説明する優しい先生

【出力形式】
板書ノートのみを書くこと。
余計な前置きは書かない。

テーマ：
${topic}
  `;

  return await openaiChat(
    [
      { role: "system", content: "あなたは優しい黒板先生くまおです。" },
      { role: "user", content: prompt }
    ],
    level
  );
}


// 深掘り講義（生徒が「もっと知りたい！」と言ったとき）
async function generateDeepLecture(topic, lastNote, question, level = "normal") {
  const prompt = `
あなたは「くまお先生」です。

【目的】
前回の板書ノートをふまえて、生徒が理解できなかった部分を
やさしく深掘りして説明する。

【ルール】
・黒板で補足説明するように語る
・数式は LINE形式
・生徒の疑問を必ず受け止めてから説明する
・絵文字は少なめ（🐻を適度に）
・最後に「つづきが聞きたい？🐻」を入れる

生徒の質問：
${question}

前回のノート：
${lastNote}
  `;

  return await openaiChat(
    [
      { role: "system", content: "あなたは対話型の優しい解説者くまお先生です。" },
      { role: "user", content: prompt }
    ],
    level
  );
}


// 生徒へノートを送る関数
async function sendLectureNote(replyToken, topic, level = "normal") {
  const note = await generateLectureNote(topic, level);

  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "📘 ノートに写しておこうね🐻\n\n" +
      note +
      "\n\nほかにも知りたいところがあれば、なんでも聞いてね🐻✨"
  });
}


// 深掘り送信
async function sendDeepLecture(replyToken, topic, lastNote, question, level = "normal") {
  const text = await generateDeepLecture(topic, lastNote, question, level);

  return client.replyMessage(replyToken, {
    type: "text",
    text
  });
}
