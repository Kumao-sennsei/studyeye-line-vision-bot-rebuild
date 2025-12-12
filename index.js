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
        "なければ「答えなし」で大丈夫だよ。",
    });
  }

  /* ---------- テキスト ---------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* =====================
     画像の答え待ち
  ===================== */
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

  /* =====================
     解説後の分岐（ここが修正点）
  ===================== */
  if (userState[userId]?.mode === "after_question") {
    // 類題へ
    if (text.includes("類題") || text.includes("練習")) {
      userState[userId] = { mode: "exercise_question" };

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね🐻🔥\n" +
          "じゃあ演習モードに進もう。\n" +
          "このあと、同じ構造で数字だけ変えた問題を出すよ。",
      });
    }

    // そのまま別の質問を続ける
    if (text.endsWith("？") || text.endsWith("?") || text.includes("とは")) {
      userState[userId] = { mode: "question_text" };
      const result = await runTextQuestionMode(text);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    }

    // 迷っている場合のガイド
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "もう一度聞きたいことがあれば、そのまま質問してね🐻✨\n" +
        "それとも、類題を解いてみる？",
    });
  }

  /* =====================
     演習モード：類題出題
  ===================== */
  if (userState[userId]?.mode === "exercise_question") {
    userState[userId].mode = "exercise_waiting_answer";

    const exercisePrompt = `
あなたは「くまお先生」。
直前に解説した問題と同じ構造で、
数字だけを変えた類題を1問作ってください。

必ず守ること
・問題の型や文章構造は変えない
・登場する数値だけを変更する
・途中の解説や答えは書かない
・中学生が読める日本語

問題文だけを書いてください。
`;

    const question = await callOpenAI([
      { role: "system", content: exercisePrompt },
    ]);

    userState[userId].exerciseQuestion = question;

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "類題いくよ🐻🔥\n\n" +
        question +
        "\n\n答えだけ送っても大丈夫だよ。",
    });
  }

  /* =====================
     演習モード：解答判定
  ===================== */
  if (userState[userId]?.mode === "exercise_waiting_answer") {
    const userAnswer = text;
    const question = userState[userId].exerciseQuestion;

    const judgePrompt = `
次の問題と生徒の答えを見て正誤だけ判断してください。

正解なら「正解」
違うなら「不正解」

問題：
${question}

生徒の答え：
${userAnswer}
`;

    const judge = await callOpenAI([
      { role: "system", content: judgePrompt },
    ]);

    userState[userId] = { mode: "after_question" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: judge.includes("正解")
        ? "いいね！その答えで合ってるよ🐻✨\n\nほかにも聞く？それとも類題を続ける？"
        : "惜しいところまで来てるよ🐻✨\n\nもう一度考える？それとも質問に戻る？",
    });
  }

  /* =====================
     質問モード開始
  ===================== */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章でそのまま質問してね。\n" +
        "画像でもOKだよ。",
    });
  }

  /* =====================
     文章質問
  ===================== */
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
   Vision 質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
やさしく、板書するように説明してください。

構成
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
「ほかに聞きたい？それともこの問題の類題を解いてみる？」
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

【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
「ほかに聞きたい？それともこの問題の類題を解いてみる？」
と書く
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
  console.log("🐻✨ 質問・演習モード 完全版 起動！");
});
