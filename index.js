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
// exercise_after_judge
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

  /* ---------- 画像の答え待ち ---------- */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    userState[userId] = {
      mode: "after_question",
      lastSummary: officialAnswer
        ? `画像の問題。公式の答えは ${officialAnswer}`
        : "画像の問題。公式の答えなし",
    };

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
      userState[userId].mode = "exercise_question";

      const prompt = buildSimilarQuestionPrompt(
        userState[userId].lastSummary
      );

      const question = await callOpenAI([
        { role: "system", content: prompt },
      ]);

      userState[userId].mode = "exercise_waiting_answer";
      userState[userId].exerciseQuestion = question;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね🐻🔥 類題いくよ。\n\n" +
          question +
          "\n\n答えだけ送っても大丈夫だよ。",
      });
    }

    userState[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "じゃあ次の質問を送ってね🐻✨",
    });
  }

  /* ---------- 演習：解答待ち ---------- */
  if (userState[userId]?.mode === "exercise_waiting_answer") {
    const judgePrompt = `
次の問題と答えを見て判定してください。
最初の行は 正解 または 不正解 のみ。
次の行に短い一言だけ。

問題：
${userState[userId].exerciseQuestion}

生徒の答え：
${text}
`;

    const judge = await callOpenAI([
      { role: "system", content: judgePrompt },
    ]);

    userState[userId].mode = "exercise_after_judge";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        judge +
        "\n\nどうする？\n" +
        "・もう1問（類題）\n" +
        "・質問に戻る",
    });
  }

  /* ---------- 演習：判定後 ---------- */
  if (userState[userId]?.mode === "exercise_after_judge") {
    if (text.includes("もう") || text.includes("類題")) {
      userState[userId].mode = "exercise_question";

      const prompt = buildSimilarQuestionPrompt(
        userState[userId].lastSummary
      );

      const question = await callOpenAI([
        { role: "system", content: prompt },
      ]);

      userState[userId].mode = "exercise_waiting_answer";
      userState[userId].exerciseQuestion = question;

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "よし🐻🔥 次の類題だよ。\n\n" +
          question +
          "\n\n答えだけ送っても大丈夫だよ。",
      });
    }

    userState[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "OK🐻✨ 質問に戻ろう。何でも聞いてね。",
    });
  }

  /* ---------- 質問モード開始 ---------- */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章でも画像でもOKだよ。",
    });
  }

  /* ---------- 文章質問 ---------- */
  if (userState[userId]?.mode === "question_text") {
    userState[userId] = {
      mode: "after_question",
      lastSummary: `文章の質問：${text}`,
    };

    const result = await runTextQuestionMode(text);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  return replyMenu(event.replyToken);
}

/* =====================
   類題プロンプト
===================== */
function buildSimilarQuestionPrompt(summary) {
  return `
あなたは「くまお先生」。

さっきの問題と同じ考え方・同じ手順で解ける類題を1問作ってください。

絶対ルール：
・問題の種類を変えない
・解き方の流れを変えない
・変えてよいのは数字だけ
・問題文は短く1問
・答えや解説は書かない

元の問題：
${summary}

出力：
問題：
`;
}

/* =====================
   Vision質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
中学生にやさしく教える先生です。

構成：
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に
ほかに聞きたい？それともこの問題の類題を解いてみる？
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
            ? `公式の答えは ${officialAnswer}`
            : "公式の答えはありません",
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
ほかに聞きたい？それともこの問題の類題を解いてみる？
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   OpenAI
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
  console.log("🐻✨ 質問 → 演習 完全版 起動！");
});
