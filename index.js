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
        "この問題の公式の答え（問題集・プリントの答え）を送ってね。\n" +
        "なければ「答えなし」でOKだよ。",
    });
  }

  /* -------- テキスト -------- */
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
  if (userState[userId]?.mode === "waiting_answer") {
    const imageId = userState[userId].imageId;
    const originalAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const explanation = await runVisionQuestionMode(base64, originalAnswer);

    userState[userId] = {
      mode: "after_question",
      originalProblemText: explanation.originalProblemText,
      detectedSubject: explanation.detectedSubject,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: explanation.text,
    });
  }

  /* 解説後 */
  if (userState[userId]?.mode === "after_question") {
    if (text.includes("類題")) {
      userState[userId].mode = "exercise";

      const exercise = await generateExercise(
        userState[userId].originalProblemText,
        userState[userId].detectedSubject
      );

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "【類題】\n" + exercise + "\n\n答えだけ送ってみよう🐻✨",
      });
    }

    if (text.includes("質問")) {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "OK！続けて質問してね🐻✨",
      });
    }
  }

  /* 質問モード開始 */
  if (text === "①" || text === "質問") {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n\n" +
        "文章で質問してもいいし、画像を送ってもOKだよ。",
    });
  }

  /* 文章質問 */
  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestionMode(text);

    userState[userId] = {
      mode: "after_question",
      originalProblemText: text,
      detectedSubject: detectSubject(text),
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
  if (/[0-9]/.test(text) && /[＋−×÷=x²x³]/.test(text)) return "calc";
  if (/[a-zA-Z]/.test(text)) return "english";
  if (/年|時代|戦|条約|人物/.test(text)) return "history";
  if (/実験|観察|理由/.test(text)) return "science_text";
  return "general";
}

/* =====================
   類題生成
===================== */
async function generateExercise(originalProblemText, subject) {
  const prompts = {
    calc: `
元の問題と構造を一切変えない。
文章の順番、聞き方、条件を変えない。
変えてよいのは数字だけ。
答えは書かない。

【元の問題】
${originalProblemText}
`,
    english: `
文法構造を変えない。
単語だけ変更。
答えは書かない。

【元の問題】
${originalProblemText}
`,
    history: `
同じ時代・同じテーマ。
問い方を変えない。
答えは書かない。

【元の問題】
${originalProblemText}
`,
    science_text: `
同じ現象。
条件だけ少し変更。
答えは書かない。

【元の問題】
${originalProblemText}
`,
    general: `
構造をできるだけ保つ。
答えは書かない。

【元の問題】
${originalProblemText}
`,
  };

  return await callOpenAI([
    { role: "system", content: prompts[subject] },
    { role: "user", content: "類題を1問作ってください。" },
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
      "① 質問がしたい\n",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻🔥 質問→演習 完全統合 起動！");
});
