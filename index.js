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
   ユーザー状態管理
===================== */
// userState[userId] = { mode, imageId }
const userState = {};

/* =====================
   Webhook（署名検証つき）
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
      res.status(200).end(); // ← LINE は必ず 200 応答
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end();
    }
  }
);

/* =====================
   メインイベント処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* =====================
        画像メッセージ
  ====================== */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の **公式の答え（問題集・プリントの答え）** を送ってね！\n\n" +
        "もし手元にないなら「答えなし」と送ってね。\n" +
        "その場合は、くまお先生が代わりに解くよ🔥",
    });
  }

  /* =====================
        テキストメッセージ
  ====================== */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* --------------------------------------
        画像の「公式の答え」を受け取る段階
    -------------------------------------- */
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      try {
        const base64 = await getImageBase64(imageId);

        const explanation = await runVisionQuestionMode(
          base64,
          officialAnswer
        );

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: explanation,
        });
      } catch (err) {
        console.error("Vision Error:", err);

        return client.replyMessage(event.replyToken, {
          type: "text",
          text:
            "画像の処理中にエラーが起きちゃったみたい🙏\n" +
            "もう一度送ってくれる？",
        });
      }
    }

    /* --------------------------------------
        質問モードへの入口
    -------------------------------------- */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！質問モードだよ🐻✨\n\n" +
          "・文章で質問する\n" +
          "・画像で送る\n\n" +
          "どちらでも大丈夫だよ！",
      });
    }

    /* --------------------------------------
        文章質問 → GPTに送る
    -------------------------------------- */
    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;

      const result = await runTextQuestionMode(text);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    }

    /* --------------------------------------
        その他のメッセージ → メニューへ
    -------------------------------------- */
    return replyMenu(event.replyToken);
  }
}

/* =====================
   Vision（画像質問）
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
const prompt = `
あなたは「くまお先生」です。明るく優しく、中高生に寄り添って説明する先生です。

【書式ルール】
・Markdown の記号（*, **, __, ~~）は禁止
・LaTeX（\\(...\\) や \\[...\\]）は禁止
・太字や特殊記号は禁止。使ってよい記号は「・」と簡単な括弧のみ
・数式は日本語で説明（例：x^3 → x の 3 乗）
・ChatGPT っぽい文章は禁止。くまお先生らしく自然に
・文は短く、板書のように読みやすく

【解答の形式】
1. 問題の要点
　画像から読み取った問題文を短くまとめる

2. 解き方
　ステップ1 → ステップ2 → ステップ3 のように進める
　各ステップは中学生にもわかる表現で

3. 解説
　考え方を丁寧にかみ砕いて説明する
　式変形は文章で補足しながら進める

4. 答え
　公式の答えが送られてきた場合 → それを基準に答えを書く
　答えがない場合 → あなたが問題を解いて答えを書く

最後に必ず：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
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
              ? `公式の答えは「${officialAnswer}」です。これを基準に説明してください。`
              : "公式の答えがありません。画像の問題を読んで自分で解いてください。",
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
   文章質問モード
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。優しく丁寧に教える、明るい先生です。

【形式】
1. 問題の要点
2. 解き方（ステップ1 → 2 → 3）
3. 解説
4. 答え

最後に必ず：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: text },
  ];

  return await callOpenAI(messages);
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
  return json.choices[0].message.content;
}

/* =====================
   LINE画像 → base64
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
   メニュー表示
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい ✏️\n" +
      "（講義・演習はまだ準備中だよ！）",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🐻✨ 質問モードBOT 起動！"));
