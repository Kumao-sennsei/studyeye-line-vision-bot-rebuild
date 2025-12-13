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
   表示文言（最終確定）
===================== */
const COPY = {
  MENU:
    "こんにちは🐻✨\n\n今日は何をする？\n" +
    "① 質問がしたい\n" +
    "② 講義を受けたい\n" +
    "③ 演習（類題）をしたい\n" +
    "④ 雑談がしたい",

  QUESTION_START:
    "質問モードだよ🐻✨\n" +
    "文章で質問してもいいし、問題の写真を送ってもOKだよ😊",

  IMAGE_RECEIVED:
    "画像を受け取ったよ🐻✨\n\n" +
    "この問題の公式の答えがあれば送ってね。\n" +
    "なければ「答えなし」で大丈夫だよ😊",

  AFTER_QUESTION:
    "ほかに聞きたい？それともこの問題の類題を解いてみる？",

  PRACTICE_GUIDE:
    "いいね🐻✨\n\n" +
    "じゃあ類題を作るよ。\n" +
    "次の3つを教えてね😊\n" +
    "① 単元\n" +
    "② 問題のタイプ\n" +
    "③ むずかしさ\n\n" +
    "※「さっきの問題と同じで、数値だけ変えて」でもOK",

  ANSWER_ONLY: "答えだけ送っても大丈夫だよ😊",

  PRAISE:
    "すごい！正解だよ🐻✨\n" +
    "ちゃんと理解できてる証拠だね😊",

  EXPLAIN_INTRO:
    "だいじょうぶだよ😊\n" +
    "ここは少し難しかったね。\n\n" +
    "まずは、この問題の考え方を\n" +
    "解説でいっしょに整理しよう🐻✨",

  LECTURE_CONFIRM:
    "この単元、講義で復習しよっか？🐻✨\n" +
    "・はい\n" +
    "・いいえ",
};

/* =====================
   ユーザー状態
===================== */
const userState = {};
/*
mode:
menu
question
image_wait
after_question
practice_condition
practice_answer
practice_explanation
lecture_confirm
lecture
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
    return reply(event.replyToken, COPY.IMAGE_RECEIVED);
  }

  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* ===== メニュー ===== */
  if (userState[userId].mode === "menu") {
    if (text.startsWith("①")) {
      userState[userId].mode = "question";
      return reply(event.replyToken, COPY.QUESTION_START);
    }
    if (text.startsWith("③")) {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_GUIDE);
    }
    return reply(event.replyToken, COPY.MENU);
  }

  /* ===== 画像質問 ===== */
  if (userState[userId].mode === "image_wait") {
    const base64 = await getImageBase64(userState[userId].imageId);
    const result = await runVisionQuestionMode(
      base64,
      text === "答えなし" ? null : text
    );

    userState[userId] = {
      mode: "after_question",
      lastProblemSummary: extractSummary(result),
    };

    return reply(event.replyToken, result);
  }

  /* ===== 文章質問 ===== */
  if (userState[userId].mode === "question") {
    const result = await runTextQuestionMode(text);

    userState[userId] = {
      mode: "after_question",
      lastProblemSummary: extractSummary(result),
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
    return reply(event.replyToken, COPY.QUESTION_START);
  }

  /* ===== 類題条件 ===== */
  if (userState[userId].mode === "practice_condition") {
    const subject = detectSubject(
      userState[userId].lastProblemSummary + " " + text
    );
    const sameOnly = text.includes("数値だけ");

    const question = await generateExercise(
      subject,
      userState[userId].lastProblemSummary,
      text,
      sameOnly
    );

    userState[userId] = {
      mode: "practice_answer",
      exerciseQuestion: question,
    };

    return reply(
      event.replyToken,
      "【類題】\n" + question + "\n\n" + COPY.ANSWER_ONLY
    );
  }

  /* ===== 類題解答 ===== */
  if (userState[userId].mode === "practice_answer") {
    if (
      text.includes("わから") ||
      text.includes("分から") ||
      text.includes("わかりません")
    ) {
      userState[userId].mode = "practice_explanation";
      return reply(event.replyToken, COPY.EXPLAIN_INTRO);
    }

    const judge = await judgeAnswer(
      userState[userId].exerciseQuestion,
      text
    );

    if (judge === "正解") {
      userState[userId].mode = "after_question";
      return reply(
        event.replyToken,
        COPY.PRAISE + "\n\n" + COPY.AFTER_QUESTION
      );
    } else {
      userState[userId].mode = "practice_explanation";
      return reply(event.replyToken, COPY.EXPLAIN_INTRO);
    }
  }

  /* ===== 類題 解説 ===== */
  if (userState[userId].mode === "practice_explanation") {
    const result = await runTextQuestionMode(
      userState[userId].exerciseQuestion
    );
    userState[userId].mode = "lecture_confirm";
    return reply(event.replyToken, result);
  }

  /* ===== 講義 確認 ===== */
  if (userState[userId].mode === "lecture_confirm") {
    if (text.includes("はい")) {
      userState[userId].mode = "lecture";
      return reply(
        event.replyToken,
        "よしっ😊\nじゃあ、この単元を講義で復習しよう🐻✨"
      );
    }
    if (text.includes("いいえ")) {
      userState[userId].mode = "after_question";
      return reply(
        event.replyToken,
        "OK😊\nじゃあ次は何しよっか？"
      );
    }
    return reply(event.replyToken, "「はい」か「いいえ」で教えてね😊");
  }

  /* ===== 講義 ===== */
  if (userState[userId].mode === "lecture") {
    userState[userId].mode = "after_question";
    return reply(
      event.replyToken,
      "🐻✨ くまお先生の講義\n\n" +
        "この単元を、教科書レベルで\n" +
        "ていねいに整理して説明するよ📘\n\n" +
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
   類題生成
===================== */
async function generateExercise(subject, summary, condition, sameOnly) {
  let rule = "";
  if (subject === "math") {
    rule = sameOnly
      ? "直前の問題と同じ構造で数値だけを変更する。"
      : "同じ単元・同じ解法で条件を少し変える。";
  } else if (subject === "english") {
    rule =
      "同じ内容で、肯定文・否定文・疑問文など視点を変える。";
  } else {
    rule =
      "同じテーマで、人物・用語・原因・結果など視点を変える。";
  }

  const prompt = `
問題文のみを1問出してください。
答え・解説は禁止です。

元の問題の要点：
${summary}

生徒の希望：
${condition}

出題ルール：
${rule}
`;

  return callOpenAI([{ role: "system", content: prompt }]);
}

/* =====================
   解説（テンプレ厳守）
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」です。
以下のテンプレートを【完全に厳守】してください。

くまお先生です！やさしく解説するね🐻✨

---

【問題の要点】

---

【解き方】

1⃣
2⃣
3⃣

---

【解説】

---

【答え】

---

ほかに聞きたい？それともこの問題の類題を解いてみる？
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

async function runVisionQuestionMode(imageBase64, answer) {
  const prompt = `
あなたは「くまお先生」です。
以下のテンプレートを【完全に厳守】してください。

くまお先生です！やさしく解説するね🐻✨

---

【問題の要点】

---

【解き方】

1⃣
2⃣
3⃣

---

【解説】

---

【答え】

---

ほかに聞きたい？それともこの問題の類題を解いてみる？

重要：
・「答えなし」の場合は必ず画像の問題を解く
・画像が見えない等の発言は禁止
`;

  return callOpenAI([
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        { type: "text", text: answer ? `答え：${answer}` : "答えなし" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
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
  console.log("🐻✨ くまお先生 BOT 最終FINAL 起動！");
});
