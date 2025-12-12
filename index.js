import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* ========= 環境変数 ========= */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ========= LINE ========= */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ========= 状態管理 ========= */
// userState[userId] = { mode, imageId }
const userState = {};

/* ========= Webhook ========= */
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

/* ========= メイン ========= */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* ---- 画像 ---- */
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
        "なければ「答えなし」でOKだよ。",
    });
  }

  /* ---- テキスト ---- */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* 公式答え待ち */
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      const base64 = await getImageBase64(imageId);
      const raw = await runVision(base64, officialAnswer);
      const filtered = sanitizeOutput(raw);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          filtered +
          "\n\nほかに聞きたいことはある？それともこの問題の類題を解いてみる？",
      });
    }

    /* 質問開始 */
    if (text === "①" || text === "質問" || text === "質問がしたい") {
      userState[userId] = { mode: "text_question" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "質問モードだよ🐻✨ 文章でも画像でも送ってね。",
      });
    }

    /* 文章質問 */
    if (userState[userId]?.mode === "text_question") {
      userState[userId] = null;

      const raw = await runText(text);
      const filtered = sanitizeOutput(raw);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          filtered +
          "\n\nほかに聞きたいことはある？それとも類題を解いてみる？",
      });
    }

    /* ありがとう等 */
    if (["ありがとう", "ありがとう！", "助かった"].includes(text)) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "どういたしまして🐻✨\n" +
          "ほかにも聞きたい？それともこの問題の類題を解いてみる？",
      });
    }

    return replyMenu(event.replyToken);
  }
}

/* ========= Vision ========= */
async function runVision(imageBase64, officialAnswer) {
  const system = `
あなたは「くまお先生」。
中高生に向けて、板書のように説明する。

禁止：
・Markdown記号（*, **, __, ~~）
・LaTeX記法
・強調装飾

OK：
・× − = ^ / の数式記号
・数字と計算式

構成：
1 問題の要点
2 解き方（ステップ形式）
3 解説
4 答え

最後に必ず：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  const messages = [
    { role: "system", content: system },
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
  ];

  return callOpenAI(messages);
}

/* ========= Text ========= */
async function runText(text) {
  const system = `
あなたは「くまお先生」。
Markdown禁止。数式記号はOK。
板書のように説明する。
`;

  return callOpenAI([
    { role: "system", content: system },
    { role: "user", content: text },
  ]);
}

/* ========= OpenAI ========= */
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

/* ========= 禁止記号フィルター ========= */
function sanitizeOutput(text) {
  return text
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\$+/g, "")
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .trim();
}

/* ========= LINE画像 ========= */
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

/* ========= メニュー ========= */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n" +
      "① 質問がしたい",
  });
}

/* ========= 起動 ========= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問モード 完全体 起動");
});

