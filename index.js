import express from "express";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";
import fetch from "node-fetch";

const app = express();

/* =====================
  環境変数
===================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ---------------------
  LINE SDK クライアント
--------------------- */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ---------------------
  ユーザー状態保存
--------------------- */
const userState = {}; // userState[userId] = { mode, subject, unit }

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
      res.status(200).end(); // ★ 502 を確実に回避
    } catch (err) {
      console.error(err);
      res.status(200).end();
    }
  }
);

/* =====================
  メイン処理
===================== */
async function handleEvent(event) {
  if (event.type !== "message") return;
  if (event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  /* ----------- あいさつ → メニュー ----------- */
  if (["こんにちは", "こんちは", "やあ", "はじめまして"].includes(text)) {
    return replyMenu(event.replyToken);
  }

  /* ============================================
      状態①：質問モード
  ============================================ */
  if (text === "質問" || text === "①") {
    userState[userId] = { mode: "question" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "いいね！質問モードだよ🐻✨\n\n" +
        "・問題文を送る\n" +
        "・写真を送る（※画像モードは後で実装）\n" +
        "・文章で質問する\n\n" +
        "好きな形で送ってね！",
    });
  }

  if (userState[userId]?.mode === "question") {
    return handleQuestionMode(event, text);
  }

  /* ============================================
      状態②：講義モード（教科 → 単元 → 講義生成）
  ============================================ */

  // 講義モード開始
  if (text === "講義" || text === "②") {
    userState[userId] = { mode: "lecture_subject" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "了解！講義モード📘✨\n\n" +
        "まずは教科（数学・物理・化学・英語など）を教えてね！",
    });
  }

  // 教科の入力待ち
  if (userState[userId]?.mode === "lecture_subject") {
    userState[userId] = { mode: "lecture_unit", subject: text };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `OK！教科は「${text}」だね📘✨\n\n` +
        "次に、単元（例：2次関数、波動、酸化還元、英文法など）を教えてね！",
    });
  }

  // 単元の入力待ち → OpenAI 講義生成
  if (userState[userId]?.mode === "lecture_unit") {
    const subject = userState[userId].subject;
    const unit = text;

    // 状態クリア
    userState[userId] = null;

    try {
      // ★ OpenAI で講義を生成
      const lectureText = await callLectureFromOpenAI(subject, unit);

      // ★ セクション分割 → LINE 文字数に合わせて分割
      const chunks = splitLectureText(lectureText, 1100);

      const messages = chunks.map((t) => ({
        type: "text",
        text: t,
      }));

      return client.replyMessage(event.replyToken, messages);
    } catch (err) {
      console.error(err);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "講義作成中にエラーが出たみたい…🙏\n" +
          "少し時間をおいて、もう一度試してくれる？",
      });
    }
  }

  /* ============================================
      状態③：演習モード（準備中）
  ============================================ */
  if (text === "演習" || text === "③") {
    userState[userId] = { mode: "exercise" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "演習モードは現在準備中だよ🐻🔥\n" +
        "次のアップデートで問題出題 → 解答 → 解説まで実装するね！",
    });
  }

  /* ============================================
      雑談モード（④）
  ============================================ */
  if (text === "雑談" || text === "④") {
    userState[userId] = { mode: "chat" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "いいね！雑談しよう～☕🐻✨ なんでも話してね！",
    });
  }

  if (userState[userId]?.mode === "chat") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `なるほど〜！🐻✨\n${text} についてもっと教えて！`,
    });
  }

  /* ----------- その他（初期メニューに戻す） ----------- */
  return replyMenu(event.replyToken);
}

/* ============================================
  質問モードの処理
============================================ */
async function handleQuestionMode(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "質問モードは現在アップデート準備中だよ🐻✨\n" +
      "次のバージョンで GPT が即回答できるようにするね！",
  });
}

/* ============================================
  OpenAI に講義生成を依頼する関数
============================================ */
async function callLectureFromOpenAI(subject, unit) {
  const systemPrompt = `
あなたは「くまお先生」です。中高生向けに、やさしく丁寧に板書のように説明します。
以下の構成にしたがい、「----」で区切ってください。

1. 導入
----
2. 基本の考え方
----
3. 具体例
----
4. つまずきポイント
----
5. まとめ
`;

  const userPrompt = `教科: ${subject}\n単元: ${unit}\nこの内容で講義を作ってください。`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("OpenAI error:", text);
    throw new Error("OpenAI request failed");
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/* ============================================
  長文を LINE 用に分割する関数
============================================ */
function splitLectureText(text, maxLength) {
  const sections = text.split(/-{4,}/);
  const chunks = [];

  for (let raw of sections) {
    let part = raw.trim();
    if (!part) continue;

    while (part.length > maxLength) {
      chunks.push(part.slice(0, maxLength));
      part = part.slice(maxLength);
    }
    if (part.length > 0) chunks.push(part);
  }

  return chunks;
}

/* ============================================
  メニュー返信
============================================ */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習がしたい 📝\n" +
      "④ 雑談したい ☕",
  });
}

/* ============================================
  起動
============================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
