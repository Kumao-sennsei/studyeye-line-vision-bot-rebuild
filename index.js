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
        "この問題の公式の答え（問題集やプリントの答え）を送ってね。\n" +
        "手元になければ「答えなし」で大丈夫だよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
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

  /* 解説後の分岐 */
  if (userState[userId]?.mode === "after_question") {
    if (text.includes("類題") || text.includes("練習")) {
      userState[userId] = { mode: "exercise_question" };
      return sendExerciseQuestion(event.replyToken, userId);
    }

    // ほかの質問なら質問モードに戻す
    userState[userId] = { mode: "question_text" };
  }

  /* 質問モード開始 */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n\n" +
        "文章でそのまま質問してね。\n" +
        "画像でも大丈夫だよ。",
    });
  }

  /* 文章質問 */
  if (userState[userId]?.mode === "question_text") {
    userState[userId] = { mode: "after_question" };
    const result = await runTextQuestionMode(text);

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
async function sendExerciseQuestion(replyToken, userId) {
  const prompt = `
あなたは「くまお先生」。
さっきの問題と同じ考え方で解ける、数字だけ変えた類題を1問作ってください。

条件：
・問題文だけを書く
・途中の説明や答えは書かない
・中学生にも読める日本語
`;

  const question = await callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: "類題を1問出してください。" },
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
   Vision質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
中学生にもわかるように、やさしく説明する先生です。

禁止：
・Markdown記号
・LaTeX
・難しい言葉
・同じ式の繰り返し

OK：
・x² や × − は使ってよい

構成：
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
ほかに聞きたいことがあるか、類題に進むか聞く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは「${officialAnswer}」です。これを基準に説明してください。`
            : "公式の答えはありません。自分で解いて説明してください。",
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
ほかに聞きたいことがあるか、類題を解くか聞く
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
  console.log("🐻✨ 質問＋演習モード 完成版 起動！");
});
