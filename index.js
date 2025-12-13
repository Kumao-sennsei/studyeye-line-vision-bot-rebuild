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
   ユーザー状態（超重要）
===================== */
const userState = {};
/*
mode:
S0_question
S1_explain_done
S2_after_question
S3_exercise_condition
S4_exercise_question
S5_exercise_judge
S6_lecture_offer
S7_lecture
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
  if (!userState[userId]) userState[userId] = { mode: "S0_question" };

  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* ========= S0 質問モード ========= */
  if (userState[userId].mode === "S0_question") {
    const answer = await runQuestion(text);
    userState[userId] = {
      mode: "S2_after_question",
      lastQuestion: text,
    };
    return reply(event, answer);
  }

  /* ========= S2 after_question ========= */
  if (userState[userId].mode === "S2_after_question") {
    if (text.includes("類題")) {
      userState[userId].mode = "S3_exercise_condition";
      return reply(
        event,
        "いいね🐻✨\n\n時代・人物・場所を一言で教えてね！"
      );
    }
    userState[userId].mode = "S0_question";
    return reply(event, "じゃあ質問してみよう😊");
  }

  /* ========= S3 条件入力 ========= */
  if (userState[userId].mode === "S3_exercise_condition") {
    const subject = detectSubject(text);
    const question = await runExercise(userState[userId].lastQuestion, subject);

    userState[userId] = {
      mode: "S5_exercise_judge",
      exerciseQuestion: question,
      subject,
    };

    return reply(
      event,
      `【類題】\n${question}\n\n答えだけ送っても大丈夫だよ😊`
    );
  }

  /* ========= S5 演習判定 ========= */
  if (userState[userId].mode === "S5_exercise_judge") {
    if (text.includes("わから")) {
      userState[userId].mode = "S6_lecture_offer";
      return reply(
        event,
        "だいじょうぶ😊\nここが一番伸びるところだよ🐻✨\n\n講義を受ける？\n・はい\n・いいえ"
      );
    }

    const judge = await judgeAnswer(
      userState[userId].exerciseQuestion,
      text
    );

    if (judge === "正解") {
      userState[userId].mode = "S2_after_question";
      return reply(event, "いいね！正解だよ🐻✨\n\n次どうする？");
    } else {
      userState[userId].mode = "S6_lecture_offer";
      return reply(
        event,
        "惜しい😊\n\n講義を受けて整理してみる？\n・はい\n・いいえ"
      );
    }
  }

  /* ========= S6 講義提案 ========= */
  if (userState[userId].mode === "S6_lecture_offer") {
    if (text === "はい") {
      userState[userId].mode = "S7_lecture";
      return reply(event, getLectureText(userState[userId].subject));
    }
    userState[userId].mode = "S2_after_question";
    return reply(event, "OK😊 じゃあ続けよう！");
  }

  /* ========= S7 講義 ========= */
  if (userState[userId].mode === "S7_lecture") {
    userState[userId].mode = "S2_after_question";
    return reply(
      event,
      "ここまでどうかな？😊\n\n次はどうする？"
    );
  }
}

/* =====================
   GPT処理
===================== */
async function runQuestion(text) {
  return callOpenAI([
    {
      role: "system",
      content:
        "あなたはくまお先生🐻✨ 中学生に黒板で教えるように説明してください。",
    },
    { role: "user", content: text },
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
        "正しければ「正解」、違えば「不正解」だけを書いてください。",
    },
    { role: "user", content: `問題:${question}\n答え:${answer}` },
  ]);
  return res.includes("正解") ? "正解" : "不正解";
}

/* =====================
   プロンプト
===================== */
function getExercisePrompt(subject) {
  return `
あなたは「くまお先生」🐻✨
直前と同じ構造・同じ解き方で類題を1問作ってください。
答え・解説は禁止。
`;
}

function getLectureText(subject) {
  return `
【くまお先生の講義🐻✨】

今日はここを整理するよ😊
・時代
・中心人物
・何が変わったか

ノートを取りながら見てね📘
`;
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
   判定
===================== */
function detectSubject(text) {
  if (text.match(/[0-9×÷]/)) return "math";
  if (text.includes("時代")) return "history";
  return "general";
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
