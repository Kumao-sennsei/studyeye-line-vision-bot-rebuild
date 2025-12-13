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
mode:
question
after_question
image_waiting_answer
exercise_condition
exercise_waiting_answer
lecture_offer
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
  if (!userState[userId]) userState[userId] = { mode: "question" };

  /* ===== 画像質問 ===== */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "image_waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答えがあれば送ってね。\n" +
        "なければ「答えなし」で大丈夫だよ😊",
    });
  }

  /* ===== テキスト以外は無視 ===== */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* ===== 画像の答え待ち ===== */
  if (userState[userId].mode === "image_waiting_answer") {
    const base64 = await getImageBase64(userState[userId].imageId);

    const result = await runVisionQuestionMode(
      base64,
      text === "答えなし" ? null : text
    );

    userState[userId] = {
      mode: "after_question",
      lastQuestion: result,
    };

    return reply(event, result);
  }

  /* ===== 質問モード ===== */
  if (userState[userId].mode === "question") {
    const result = await runTextQuestionMode(text);
    userState[userId] = {
      mode: "after_question",
      lastQuestion: text,
    };
    return reply(event, result);
  }

  /* ===== 解説後分岐 ===== */
  if (userState[userId].mode === "after_question") {
    if (text.includes("類題") || text.includes("練習")) {
      userState[userId].mode = "exercise_condition";
      return reply(
        event,
        "いいね😊\n\n類題を作るよ🐻✨\n時代・人物・場所を一言で教えてね！"
      );
    }

    userState[userId].mode = "question";
    return reply(event, "じゃあ、次の質問をどうぞ😊");
  }

  /* ===== 演習：条件入力 ===== */
  if (userState[userId].mode === "exercise_condition") {
    const subject = detectSubject(text);
    const question = await runExercise(
      userState[userId].lastQuestion,
      subject
    );

    userState[userId] = {
      mode: "exercise_waiting_answer",
      exerciseQuestion: question,
      subject,
    };

    return reply(
      event,
      "【類題】\n" +
        question +
        "\n\n答えだけ送っても大丈夫だよ😊"
    );
  }

  /* ===== 演習：判定 ===== */
  if (userState[userId].mode === "exercise_waiting_answer") {
    if (text.includes("わから")) {
      userState[userId].mode = "lecture_offer";
      return reply(
        event,
        "だいじょうぶ😊\nここが一番の伸びポイントだよ🐻✨\n\nこのテーマの講義を受ける？\n・はい\n・いいえ"
      );
    }

    const judge = await judgeAnswer(
      userState[userId].exerciseQuestion,
      text
    );

    if (judge === "正解") {
      userState[userId].mode = "after_question";
      return reply(
        event,
        "いいね！正解だよ🐻✨\n\nほかに聞きたい？それとも類題を続ける？"
      );
    } else {
      userState[userId].mode = "lecture_offer";
      return reply(
        event,
        "惜しい😊\n\nこのテーマの講義を受けて整理してみる？\n・はい\n・いいえ"
      );
    }
  }

  /* ===== 講義提案 ===== */
  if (userState[userId].mode === "lecture_offer") {
    if (text === "はい") {
      userState[userId].mode = "after_question";
      return reply(
        event,
        getLectureText()
      );
    }

    userState[userId].mode = "after_question";
    return reply(event, "OK😊 じゃあ続けよう！");
  }
}

/* =====================
   GPT処理
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。
中学生・高校生どちらにも分かるように、
黒板で説明する先生の口調で教えてください。

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

async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」。
中学生・高校生に向けて、
やさしく、順番に説明してください。

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

async function runExercise(baseText, subject) {
  return callOpenAI([
    { role: "system", content: getExercisePrompt(subject) },
    { role: "user", content: baseText },
  ]);
}

async function judgeAnswer(question, answer) {
  const res = await callOpenAI([
    {
      role: "system",
      content:
        "次の問題と答えを見て、正しければ「正解」、違えば「不正解」だけを書いてください。",
    },
    { role: "user", content: `問題:${question}\n答え:${answer}` },
  ]);
  return res.includes("正解") ? "正解" : "不正解";
}

/* =====================
   類題プロンプト
===================== */
function getExercisePrompt(subject) {
  return `
あなたは「くまお先生」。
直前の問題と同じ構造・同じ解き方で、
内容だけを少し変えた類題を1問作ってください。

条件：
・解法は変えない
・答えや解説は書かない
・問題文のみを書く
`;
}

/* =====================
   講義（中身は後フェーズ）
===================== */
function getLectureText() {
  return `
🐻✨ くまお先生のミニ講義

ここでは、
・その時代・分野の全体像
・大事なポイント
・よく間違えやすいところ
を整理して説明するよ😊

ノートを取りながら見てみよう📘
`;
}

/* =====================
   教科判定
===================== */
function detectSubject(text) {
  if (text.match(/[0-9×÷]/)) return "math";
  if (text.includes("時代") || text.includes("天皇")) return "history";
  if (text.match(/[a-zA-Z]/)) return "english";
  return "general";
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
   reply helper
===================== */
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ くまお先生 起動！");
});
