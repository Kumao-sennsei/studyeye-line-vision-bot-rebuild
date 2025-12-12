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
      console.error(err);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン handleEvent (完全統合)
===================== */

async function handleEvent(event) {
  const userId = event.source.userId;

  /* =======================
      画像モード（質問）
  ======================= */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の **公式の答え（解答冊子の答え）** を送ってね！\n\n" +
        "ない場合は「答えなし」と送ってくれたら\n" +
        "くまお先生が代わりに解くよ🔥",
    });
  }

  /* =======================
      テキストモード
  ======================= */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* ---- 挨拶 → メニュー ---- */
    if (["こんにちは", "やあ", "はじめまして"].includes(text)) {
      return replyMenu(event.replyToken);
    }

    /* ======================================
       画像の公式答え待ち → 本解説
    ====================================== */
    if (userState[userId]?.mode === "waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      try {
        const base64 = await getImageBase64(imageId);
        const result = await runVisionQuestionMode(base64, officialAnswer);

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: result,
        });
      } catch (err) {
        console.error(err);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "画像処理中にエラーが起きたよ🙏 もう一度送ってね！",
        });
      }
    }

    /* ======================================
         質問モード（文章）
    ====================================== */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "質問モードだよ🐻✨\n\n" +
          "・文章で質問\n" +
          "・画像で送る\n\n" +
          "どっちでもOKだよ！",
      });
    }

    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;

      const result = await runTextQuestionMode(text);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    }

    /* ======================================
         講義モード
    ====================================== */
    if (text === "②" || text === "講義") {
      userState[userId] = { mode: "lecture_subject" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！講義モード📘✨\n教科を教えてね！（数学/物理/化学など）",
      });
    }

    if (userState[userId]?.mode === "lecture_subject") {
      userState[userId] = {
        mode: "lecture_unit",
        subject: text,
      };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `教科は「${text}」だね📘✨\n次は単元を教えてね！`,
      });
    }

    if (userState[userId]?.mode === "lecture_unit") {
      const { subject } = userState[userId];
      const unit = text;

      userState[userId] = null;

      try {
        const lecture = await createLecture(subject, unit);
        const chunks = splitLongText(lecture, 1100);

        return client.replyMessage(
          event.replyToken,
          chunks.map((c) => ({ type: "text", text: c }))
        );
      } catch (err) {
        console.error(err);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "講義生成でエラーが起きたよ🙏 もう一度ためしてね！",
        });
      }
    }

    /* ======================================
         雑談モード
    ====================================== */
    if (text === "④" || text === "雑談") {
      userState[userId] = { mode: "chat" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "雑談しよ〜☕🐻✨ なんでも話してね！",
      });
    }

    if (userState[userId]?.mode === "chat") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `なるほどね〜🐻✨\n${text} についてもっと教えて！`,
      });
    }

    /* ======================================
         メニューに戻す
    ====================================== */
    return replyMenu(event.replyToken);
  }
}

/* =====================
   Vision 質問
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。明るく優しく、中高生に寄り添って説明する先生です。

以下のルールを必ず守ってください。

【書式ルール】
- Markdown の ** や __、LaTeX（\(...\) や \[...\]）は禁止
- 太字、記号装飾を勝手に入れない
- 数式は日本語と数字でわかりやすく説明する（例：x^3 を x の 3 乗）
- ChatGPT っぽい文章は禁止。くまお先生らしい自然な日本語で。
- 文は短く、板書のように読みやすく。
- 箇条書きは「・」だけを使う

【解答の形式】
1. 問題の要点  
　画像から読み取った問題文を短くまとめる

2. 解き方  
　ステップ1 → ステップ2 → ステップ3 のように、必要な分だけ  
　各ステップは中学生にもわかる表現で説明する

3. 解説  
　考え方を丁寧に、かみ砕いて説明する  
　式変形も文章で補足しながら説明する

4. 答え  
　公式の答えが送られてきた場合はそれを基準に  
　ない場合は自分で答えを出す

最後は必ず一言つける：  
「このページ、ノートに写しておくと復習しやすいよ🐻✨」


  const messages = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            officialAnswer
              ? `この問題の公式の答えは「${officialAnswer}」です。これを基準に解説してください。`
              : "公式の答えはありません。あなたが問題を解き、正答を出してください。",
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

1. 【問題の要点】
2. 【解き方】（ステップ1→2→3）
3. 【解説】
4. 【答え】

最後に「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: text },
  ];

  return await callOpenAI(messages);
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
   メニュー返信
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習したい（準備中）📝\n" +
      "④ 雑談したい ☕\n",
  });
}

/* =====================
   長文分割
===================== */
function splitLongText(text, maxLen) {
  const arr = [];
  while (text.length > maxLen) {
    arr.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  arr.push(text);
  return arr;
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🐻✨ くまお先生 起動しました！"));
