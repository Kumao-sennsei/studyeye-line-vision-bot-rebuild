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
// mode:
// question_text
// waiting_answer
// after_question
// exercise_question
// exercise_waiting_answer
const userState = {};

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

  /* ---------- 画像 ---------- */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答えを送ってね。\n" +
        "なければ「答えなし」で大丈夫だよ。",
    });
  }

  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* ---------- 画像の答え待ち ---------- */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    userState[userId] = { mode: "after_question" };

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* ---------- 解説後の分岐 ---------- */
  if (userState[userId]?.mode === "after_question") {
    if (text.includes("類題") || text.includes("練習")) {
      userState[userId] = { mode: "exercise_question" };
      return sendExerciseQuestion(event.replyToken, userId);
    }

    // ほかの質問 → 質問モードに戻す
    userState[userId] = { mode: "question_text" };
  }

  /* ---------- 質問モード開始 ---------- */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n\n" +
        "文章で質問してもOK。\n" +
        "画像で送っても大丈夫だよ。",
    });
  }

  /* ---------- 文章質問 ---------- */
  if (userState[userId]?.mode === "question_text") {
    userState[userId] = { mode: "after_question" };
    const result = await runTextQuestionMode(text);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* ---------- 初期メニュー ---------- */
  return replyMenu(event.replyToken);
}

/* =====================
   演習モード：類題出題
===================== */
async function sendExerciseQuestion(replyToken, userId) {
  const prompt = `
あなたは「くまお先生」です。

直前に解説した問題と
【構造が完全に同じ】類題を1問作ってください。

【最重要ルール】
・問題の種類
・文章の形
・解き方の流れ
・式の並び
は元の問題と完全に同じにする

【変えてよいもの】
・数値だけ

【絶対に禁止】
・別ジャンルの問題
・文章題への変更
・説明や答えを書くこと

【出力】
・問題文のみ
`;

  const question = await callOpenAI([
    { role: "system", content: prompt },
  ]);

  userState[userId] = {
    mode: "exercise_waiting_answer",
    exerciseQuestion: question,
  };

  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "いいね🐻🔥\n\n" +
      question +
      "\n\n答えだけ送っても大丈夫だよ。",
  });
}

/* =====================
   演習モード：解答判定
===================== */
async function handleExerciseAnswer(text, userId, replyToken) {
  const question = userState[userId].exerciseQuestion;

  const judgePrompt = `
次の問題と生徒の答えを見て、
正しいかどうかだけを判定してください。

正解なら「正解」。
違うなら「不正解」。

理由は書かない。

問題：
${question}

生徒の答え：
${text}
`;

  const judge = await callOpenAI([
    { role: "system", content: judgePrompt },
  ]);

  let reply = "";

  if (judge.includes("正解")) {
    reply =
      "いいね🐻✨ 正解だよ。\n\n" +
      "どうする？\n" +
      "・もう1問、類題を解く\n" +
      "・質問に戻る";
  } else {
    reply =
      "惜しい！もう一度考えてみよう🐻✨\n\n" +
      "どうする？\n" +
      "・もう一度この問題を考える\n" +
      "・質問に戻る";
  }

  userState[userId] = { mode: "after_question" };

  return client.replyMessage(replyToken, {
    type: "text",
    text: reply,
  });
}

/* =====================
   Vision質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。

【ルール】
・Markdown禁止
・LaTeX禁止
・装飾禁止
・× − x² は使用OK
・同じ式を何度も書かない
・やさしい言葉だけ使う

【構成】
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
「ほかに聞きたいことある？それともこの問題の類題を解いてみる？」
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは「${officialAnswer}」です。`
            : "公式の答えはありません。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

/* =====================
   文章質問
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。

【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
「ほかに聞きたいことある？それともこの問題の類題を解いてみる？」
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   OpenAI 共通
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
   メニュー
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問 → 演習 完全統合版 起動！");
});
