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
   プロンプト
===================== */

const BASE_RULE_PROMPT = `
あなたは「くまお先生」。
とてもやさしく明るく、生徒に寄り添って説明します🐻✨

【表記ルール】
・Markdown記法は禁止（**、--- 等使わない）
・LaTeX記法は禁止
・仕切り線は使わない
・√、√2、10²³ は使用OK
・分数は a/b の形

【必須テンプレ】
くまお先生です！やさしく解説するね🐻✨

【問題の要点】

【解き方】
1⃣
2⃣
3⃣

【解説】

【答え】
`;

const QUESTION_SYSTEM_PROMPT = BASE_RULE_PROMPT;

const EXERCISE_RULE_PROMPT = `
【類題ルール】
・必ず答えを書く
・記述問題は正答例を書く
・直前の問題と同じ単元・考え方
`;

const EXERCISE_SYSTEM_PROMPT =
  BASE_RULE_PROMPT + EXERCISE_RULE_PROMPT;

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

  /* 画像 */
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n" +
        "公式の答えが分かれば送ってね。\n" +
        "なければ「答えなし」でOKだよ😊",
    });
  }

  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
  if (userState[userId]?.mode === "waiting_answer") {
    const base64 = await getImageBase64(userState[userId].imageId);
    const result = await runVisionQuestionMode(base64, text);
    userState[userId] = { mode: "after_question" };
    return client.replyMessage(event.replyToken, { type: "text", text: result });
  }

  /* 類題を選択 */
  if (userState[userId]?.mode === "after_question" && text.includes("類題")) {
    userState[userId].mode = "exercise_question";
    return handleEvent(event);
  }

  /* 類題出題 */
  if (userState[userId]?.mode === "exercise_question") {
    const question = await callOpenAI([
      { role: "system", content: EXERCISE_SYSTEM_PROMPT },
      { role: "user", content: userState[userId].lastQuestion || "" },
    ]);

    userState[userId] = {
      mode: "exercise_waiting_answer",
      exerciseQuestion: question,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "【類題】\n" + question,
    });
  }

  /* 類題の解説 → 講義確認 */
  if (userState[userId]?.mode === "exercise_waiting_answer") {
    const explanation = await callOpenAI([
      { role: "system", content: QUESTION_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "問題:\n" +
          userState[userId].exerciseQuestion +
          "\n生徒の答え:\n" +
          text,
      },
    ]);

    userState[userId] = { mode: "ask_lecture" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        explanation +
        "\n\nこの単元、講義で復習しよっか？🐻✨\nはい / いいえ",
    });
  }

  /* 講義確認 */
  if (userState[userId]?.mode === "ask_lecture") {
    if (text === "はい") {
      userState[userId] = { mode: "lecture" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "講義モードは準備中だよ📘",
      });
    }

    if (text === "いいえ") {
      userState[userId] = { mode: "menu" };
      return replyMenu(event.replyToken);
    }
  }

  /* 質問モード */
  if (text === "①" || text.includes("質問")) {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n文章でも画像でも送ってOKだよ😊",
    });
  }

  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestionMode(text);
    userState[userId] = {
      mode: "after_question",
      lastQuestion: text,
    };
    return client.replyMessage(event.replyToken, { type: "text", text: result });
  }

  return replyMenu(event.replyToken);
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
  return json.choices?.[0]?.message?.content || "";
}

async function runTextQuestionMode(text) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
}

async function runVisionQuestionMode(imageBase64, officialAnswer) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: officialAnswer || "答えなし" },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

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

function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "次は何しよっか？🐻✨\n" +
      "① 質問がしたい😊\n" +
      "② 講義を受けたい📘\n" +
      "③ 演習（類題）をしたい✏️\n" +
      "④ 雑談がしたい💬",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 起動しました");
});
