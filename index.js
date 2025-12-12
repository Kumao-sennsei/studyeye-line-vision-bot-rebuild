import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// userState[userId] = { mode, imageId }
const userState = {};

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

async function handleEvent(event) {
  const userId = event.source.userId;

  // 画像を受信
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ。\n" +
        "この問題の公式の答えを送ってね。\n" +
        "手元になければ「答えなし」でOK。",
    });
  }

  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 公式答え待ち
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      const base64 = await getImageBase64(imageId);
      const result = await runVisionQuestion(base64, officialAnswer);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    }

    // 質問モード開始
    if (text === "①" || text === "質問" || text === "質問がしたい") {
      userState[userId] = { mode: "question" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "質問モードだよ。\n" +
          "文章でも画像でも送ってね。",
      });
    }

    // 類題遷移（今回は案内だけ）
    if (text.includes("類題")) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK。\n" +
          "ここから演習モードに進むよ。\n" +
          "（演習モードは次の実装でつなぐ予定）",
      });
    }

    return replyMenu(event.replyToken);
  }
}

async function runVisionQuestion(imageBase64, officialAnswer) {
  const systemPrompt = `
あなたは「くまお先生」。
中高生に教える先生。

次のルールを必ず守る。

・Markdown記号は使わない
・強調記号は使わない
・数式は x² x³ のように表示する
・同じ式を繰り返さない
・途中計算は整理して書く
・板書のように説明する

構成は必ず次の順。

問題の要点
解き方
解説
答え

最後に必ず質問する。
ほかに聞きたい？
それともこの問題の類題を解いてみる？
`;

  const userText = officialAnswer
    ? `公式の答えは ${officialAnswer} です。これを基準に解説してください。`
    : `公式の答えはありません。自分で解いて正しい答えを出してください。`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  return await callOpenAI(messages);
}

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
      "今日は何をする？\n" +
      "① 質問がしたい",
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("質問モード 起動完了");
});
