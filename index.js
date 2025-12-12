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
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* 画像 → 答え待ち */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の公式の答え（解答冊子の答え）を送ってね。\n" +
        "もし無いなら「答えなし」と送ってね。\n" +
        "その場合は、くまお先生が代わりに解くよ🔥",
    });
  }

  /* テキスト */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* 挨拶 → メニュー */
    if (["こんにちは", "おはよう", "やあ", "はじめまして"].includes(text)) {
      return replyMenu(event.replyToken);
    }

    /* 画像答え → 本解説 */
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      try {
        const base64 = await getImageBase64(imageId);
        let explanation = await runVisionQuestionMode(base64, officialAnswer);

        explanation = cleanText(explanation); // 🧹禁止記号フィルター

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: explanation,
        });
      } catch (err) {
        console.error("Vision Error:", err);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "画像処理中にエラーが出ちゃった🙏 もう一度送ってね！",
        });
      }
    }

    /* 質問モードに入る */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！質問モードだよ🐻✨\n\n" +
          "・文章で質問\n" +
          "・画像で送る\n\n" +
          "どちらでも大丈夫だよ！",
      });
    }

    /* 文章質問 → GPT */
    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;

      let answer = await runTextQuestionMode(text);

      answer = cleanText(answer); // 🧹禁止記号フィルター

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: answer,
      });
    }

    return replyMenu(event.replyToken);
  }
}

/* =====================
   Vision（画像質問）
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。明るく優しく、中高生に寄り添って説明します。

【書式ルール】
・Markdown 記号は禁止（*, **, _, __, ~~ など）
・LaTeX（\\(...\\)、\\[...\\]、$...$）は禁止
・太字や強調は禁止
・使ってよい記号は「・」のみ
・数式は日本語で説明（例：x^3 → x の 3 乗）
・ChatGPT っぽい文章は禁止。自然な日本語にする
・文は短く、板書みたいに読みやすく

【解答形式】
1. 問題の要点
2. 解き方（ステップ1 → 2 → 3）
3. 解説
4. 答え
最後は必ず「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  const messages = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            officialAnswer
              ? `公式の答えは「${officialAnswer}」。これを基準に説明してね。`
              : "公式の答えはありません。自分で解いて説明してね。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  return await callOpenAI(messages);
}

/* =====================
   文章質問
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。優しく明るく説明します。

【形式】
1. 問題の要点
2. 解き方（ステップ1 → ステップ2 → ステップ3）
3. 解説
4. 答え

最後に「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  return await callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   OpenAI 呼び出し
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
  return cleanText(json.choices[0].message.content); // ←最後に必ずフィルター
}

/* =====================
   禁止記号フィルター
===================== */
function cleanText(text) {
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/__/g, "")
    .replace(/_/g, "")
    .replace(/~~/g, "")
    .replace(/\$/g, "")
    .replace(/\\\(/g, "")
    .replace(/\\\)/g, "")
    .replace(/\\\[/g, "")
    .replace(/\\\]/g, "")
    .trim();
}

/* =====================
   画像 → base64
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
      "① 質問がしたい\n" +
      "（講義・演習は準備中だよ）",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🐻🔥 質問モード 完成版 起動！"));
