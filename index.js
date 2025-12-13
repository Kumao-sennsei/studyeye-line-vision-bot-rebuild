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
   表示文言（承認制）
===================== */
const COPY = {
  MENU:
    "こんにちは🐻✨\n\n今日は何をする？\n" +
    "① 質問がしたい\n" +
    "② 講義を受けたい\n" +
    "③ 演習がしたい\n" +
    "④ 雑談がしたい",

  ENTER_QUESTION:
    "質問モードだよ🐻✨\n" +
    "文章で質問してもOK。\n" +
    "問題の写真を送っても大丈夫だよ。",

  PRACTICE_GUIDE:
    "いいね🐻✨\n\nじゃあ類題を作るよ。\n" +
    "次の3つを教えてね😊\n" +
    "① 単元（例：定積分、二次関数）\n" +
    "② 問題のタイプ（例：計算、文章題）\n" +
    "③ むずかしさ（例：やさしめ、ふつう）\n\n" +
    "例：\n定積分 計算 やさしめ\n\n" +
    "※「さっきの問題と同じで、数値だけ変えて」でもOK",

  IMG_RECEIVED:
    "画像を受け取ったよ🐻✨\n\n" +
    "この問題の公式の答えがあれば送ってね。\n" +
    "なければ「答えなし」で大丈夫だよ😊",

  AFTER_QUESTION:
    "ほかに聞きたいことある？\n" +
    "それとも、この問題の類題を解いてみる？\n\n" +
    "類題を解くなら、\n" +
    "単元（または 時代・人物・場所）を教えてね🐻✨",

  ANSWER_ONLY: "答えだけ送っても大丈夫だよ😊",

  LECTURE_OFFER:
    "だいじょうぶだよ😊\n" +
    "ここが一番の伸びポイントだね🐻✨\n\n" +
    "このテーマの講義を受ける？\n" +
    "・はい\n・いいえ",
};

/* =====================
   ユーザー状態
===================== */
const userState = {};
/*
mode:
menu
question
after_question
image_wait
practice_condition
practice_answer
lecture_offer

memory:
lastProblemSummary
exerciseQuestion
practiceCondition
subject
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
  if (!userState[userId]) userState[userId] = { mode: "menu" };

  /* ===== 画像 ===== */
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "image_wait",
      imageId: event.message.id,
    };
    return reply(event.replyToken, COPY.IMG_RECEIVED);
  }

  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* ===== メニュー ===== */
  if (userState[userId].mode === "menu") {
    if (text.startsWith("①")) {
      userState[userId].mode = "question";
      return reply(event.replyToken, COPY.ENTER_QUESTION);
    }
    if (text.startsWith("③")) {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_GUIDE);
    }
    return reply(event.replyToken, COPY.MENU);
  }

  /* ===== 画像回答 ===== */
  if (userState[userId].mode === "image_wait") {
    const base64 = await getImageBase64(userState[userId].imageId);
    const result = await runVisionQuestionMode(
      base64,
      text === "答えなし" ? null : text
    );

    const summary = extractSummary(result);

    userState[userId] = {
      mode: "after_question",
      lastProblemSummary: summary,
    };

    return reply(event.replyToken, result);
  }

  /* ===== 質問 ===== */
  if (userState[userId].mode === "question") {
    const result = await runTextQuestionMode(text);
    const summary = extractSummary(result);

    userState[userId] = {
      mode: "after_question",
      lastProblemSummary: summary,
    };

    return reply(event.replyToken, result);
  }

  /* ===== after_question ===== */
  if (userState[userId].mode === "after_question") {
    if (text.includes("類題") || text.startsWith("③")) {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_GUIDE);
    }
    userState[userId].mode = "question";
    return reply(event.replyToken, COPY.ENTER_QUESTION);
  }

  /* ===== 演習条件 ===== */
  if (userState[userId].mode === "practice_condition") {
    const subject = detectSubject(
      userState[userId].lastProblemSummary + " " + text
    );

    const sameStructure = text.includes("数値だけ変");

    const question = await generateExercise(
      subject,
      userState[userId].lastProblemSummary,
      text,
      sameStructure
    );

    userState[userId] = {
      mode: "practice_answer",
      exerciseQuestion: question,
      subject,
    };

    return reply(
      event.replyToken,
      "【類題】\n" + question + "\n\n" + COPY.ANSWER_ONLY
    );
  }

  /* ===== 演習回答 ===== */
  if (userState[userId].mode === "practice_answer") {
    if (text.includes("わから")) {
      userState[userId].mode = "lecture_offer";
      return reply(event.replyToken, COPY.LECTURE_OFFER);
    }

    const judge = await judgeAnswer(
      userState[userId].exerciseQuestion,
      text
    );

    if (judge === "正解") {
      userState[userId].mode = "after_question";
      return reply(
        event.replyToken,
        "いいね！正解だよ🐻✨\n\n" + COPY.AFTER_QUESTION
      );
    } else {
      userState[userId].mode = "lecture_offer";
      return reply(event.replyToken, COPY.LECTURE_OFFER);
    }
  }

  /* ===== 講義提案 ===== */
  if (userState[userId].mode === "lecture_offer") {
    userState[userId].mode = "after_question";
    return reply(
      event.replyToken,
      "🐻✨ くまお先生の講義\n\n" +
        "このテーマを整理して説明するよ。\n" +
        "ノートを取りながら聞いてね📘\n\n" +
        COPY.AFTER_QUESTION
    );
  }
}

/* =====================
   教科判定
===================== */
function detectSubject(text) {
  if (text.match(/[0-9×÷]/)) return "math";
  if (text.match(/[a-zA-Z]/)) return "english";
  if (text.includes("反応") || text.includes("力")) return "science";
  return "history";
}

/* =====================
   類題生成（最終思想）
===================== */
async function generateExercise(subject, summary, condition, sameOnly) {
  let rule = "";

  if (subject === "math") {
    rule = sameOnly
      ? "直前の問題と完全に同じ構造で、数値だけを変更する。"
      : "同じ単元・同じ解法で、数値や条件を少し変える。";
  } else if (subject === "english") {
    rule =
      "同じ内容の文を使い、肯定文・否定文・疑問文など視点を変える。";
  } else {
    rule =
      "同一テーマを使い、人物・用語・原因・結果など視点を変える。";
  }

  const prompt = `
あなたは「くまお先生」🐻✨

元の問題の要点：
${summary}

生徒の希望：
${condition}

出題ルール：
${rule}

条件：
・問題文のみ
・答えや解説は禁止
・1問だけ
`;

  return callOpenAI([{ role: "system", content: prompt }]);
}

/* =====================
   解説モード
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」🐻✨

【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に必ず以下をそのまま書く：
${COPY.AFTER_QUESTION}
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

async function runVisionQuestionMode(imageBase64, answer) {
  return runTextQuestionMode("（画像問題）");
}

/* =====================
   判定
===================== */
async function judgeAnswer(q, a) {
  const res = await callOpenAI([
    {
      role: "system",
      content:
        "正しければ「正解」、違えば「不正解」だけを書いてください。",
    },
    { role: "user", content: `問題:${q}\n答え:${a}` },
  ]);
  return res.includes("正解") ? "正解" : "不正解";
}

/* =====================
   要約抽出
===================== */
function extractSummary(text) {
  const m = text.match(/【問題の要点】([\s\S]*?)【/);
  return m ? m[1].trim() : text.slice(0, 40);
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
      temperature: 0.2,
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
   reply
===================== */
function reply(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ くまお先生 最終形態 起動！");
});
