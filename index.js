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
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答えを送ってね。\n" +
        "なければ「答えなし」でOKだよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    userState[userId].mode = "after_question";

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    userState[userId].lastQuestionSummary = result;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* 解説後の分岐 */
  if (userState[userId]?.mode === "after_question") {
    if (text.includes("類題") || text.includes("練習")) {
      userState[userId].mode = "exercise_question";
      return handleExerciseQuestion(event);
    }

    // ほかの質問 → 質問モードに戻す
    userState[userId].mode = "question_text";
  }

  /* 質問モード開始 */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n\n" +
        "文章で質問してもいいし、\n" +
        "画像を送ってもOKだよ。",
    });
  }

  /* 文章質問 */
  if (userState[userId]?.mode === "question_text") {
    userState[userId].mode = "after_question";
    const result = await runTextQuestionMode(text);
    userState[userId].lastQuestionSummary = result;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* 初期メニュー */
  return replyMenu(event.replyToken);
}

/* =====================
   演習モード：類題出題
===================== */
async function handleExerciseQuestion(event) {
  const userId = event.source.userId;

  const classifyPrompt = `
次の問題は計算構造がありますか？
「はい」か「いいえ」だけで答えてください。

判断基準：
・数式や計算が中心 → はい
・人物名や用語を答える → いいえ

問題：
${userState[userId].lastQuestionSummary}
`;

  const classify = await callOpenAI([
    { role: "system", content: classifyPrompt },
  ]);

  let exercisePrompt = "";

  if (classify.includes("はい")) {
    exercisePrompt = `
あなたは演習問題を作る先生です。
直前の問題と同じ式の形、同じ解き方を使います。
変えてよいのは数字だけです。
文字、構造、問い方は変えてはいけません。
途中の説明は書かず、問題文だけを書いてください。
`;
  } else {
    exercisePrompt = `
あなたは演習問題を作る先生です。
直前の問題と同じ時代、同じテーマ、同じ問い方を使います。
人物名、場所名、出来事のうち一つだけを入れ替えてください。
計算問題や文章題に変えてはいけません。
問題文だけを書いてください。
`;
  }

  const question = await callOpenAI([
    { role: "system", content: exercisePrompt },
    { role: "user", content: "類題を1問出してください。" },
  ]);

  userState[userId].mode = "exercise_waiting_answer";
  userState[userId].exerciseQuestion = question;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "いいね🐻🔥\n\n" +
      question +
      "\n\n答えだけ送っても大丈夫だよ。",
  });
}

/* =====================
   Vision質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
中学生にもわかるように、やさしく説明する先生です。

必ず守ること：
・Markdown禁止
・LaTeX禁止
・装飾禁止
・難しい言葉禁止
・同じ式を何度も書かない

構成：
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
ほかに聞きたいことある？
それともこの問題の類題を解いてみる？
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

構成：
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
ほかに聞きたいことある？
それともこの問題の類題を解いてみる？
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   OpenAI共通
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
  console.log("🐻✨ 質問＋演習モード 完全体 起動！");
});
