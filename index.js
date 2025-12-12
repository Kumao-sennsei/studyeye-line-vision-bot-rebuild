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

/*
state:
question_text
waiting_answer
after_question
exercise_question
exercise_waiting_answer
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

  /* -------- 画像 -------- */
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

  /* -------- テキスト -------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    userState[userId] = {
      mode: "after_question",
      lastQuestionText: result,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* 解説後 */
  if (userState[userId]?.mode === "after_question") {
    if (text.includes("類題")) {
      userState[userId].mode = "exercise_question";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいね🐻🔥\n" +
          "さっきの問題と同じ形で、数字だけ変えた問題を出すよ。",
      });
    }

    // そのまま新しい質問
    userState[userId] = { mode: "question_text" };
  }

  /* ===== 演習モード：類題出題 ===== */
  if (userState[userId]?.mode === "exercise_question") {
    const subject = detectSubject(userState[userId].lastQuestionText);
    const prompt = getExercisePrompt(subject);

    const question = await callOpenAI([
      { role: "system", content: prompt },
      { role: "user", content: userState[userId].lastQuestionText },
    ]);

    userState[userId] = {
      mode: "exercise_waiting_answer",
      exerciseQuestion: question,
      subject,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "【類題】\n" +
        question +
        "\n\n答えだけ送っても大丈夫だよ。",
    });
  }

  /* ===== 演習モード：解答 or 分からない ===== */
  if (userState[userId]?.mode === "exercise_waiting_answer") {
    if (text.includes("分から")) {
      const explain = await runTextQuestionMode(
        userState[userId].exerciseQuestion
      );

      userState[userId].mode = "after_question";

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: explain,
      });
    }

    const judge = await callOpenAI([
      {
        role: "system",
        content:
          "次の問題と答えを見て、正しければ「正解」、違えば「不正解」だけを書いてください。",
      },
      {
        role: "user",
        content:
          "問題:\n" +
          userState[userId].exerciseQuestion +
          "\n答え:\n" +
          text,
      },
    ]);

    userState[userId].mode = "after_question";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        (judge.includes("正解")
          ? "いいね！正解だよ🐻✨"
          : "惜しい！でも大丈夫🐻✨") +
        "\n\nほかに聞きたい？それともこの問題の類題を解いてみる？",
    });
  }

  /* 質問モード開始 */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章で質問してもいいし、画像でもOKだよ。",
    });
  }

  /* 文章質問 */
  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestionMode(text);
    userState[userId] = {
      mode: "after_question",
      lastQuestionText: text,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  return replyMenu(event.replyToken);
}

/* =====================
   教科判定
===================== */
function detectSubject(text) {
  if (text.match(/[xX0-9＋－×÷]/)) return "math";
  if (text.includes("天皇") || text.includes("時代")) return "history";
  if (text.match(/[a-zA-Z]/)) return "english";
  return "general";
}

/* =====================
   類題プロンプト
===================== */
function getExercisePrompt(subject) {
  if (subject === "math") {
    return `
あなたは中学生向けの数学の先生です。
直前の問題と全く同じ構造・同じ解き方で、
数字だけを変えた類題を1問作ってください。

条件：
・文章構造を変えない
・解法を変えない
・答えや解説は書かない
・問題文のみを書く
`;
  }

  if (subject === "history") {
    return `
あなたは中学生向けの歴史の先生です。
直前の問題と同じ時代・同じ問い方で、
人物名や年号だけを変えた類題を1問作ってください。

条件：
・時代を変えない
・問いの形式を変えない
・答えは書かない
`;
  }

  return `
直前の問題と同じ形式で、内容を少しだけ変えた類題を1問作ってください。
答えは書かないでください。
`;
}

/* =====================
   質問モード（文章）
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。
中学生に黒板で教えるように説明します。

【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に必ず
「ほかに聞きたい？それともこの問題の類題を解いてみる？」
と書く
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   Vision質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
やさしく、短く、分かりやすく説明します。

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
  console.log("🐻✨ 完成版 起動！");
});
