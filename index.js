/* ======================================================
   くまお先生（B方式：自然会話モード切替）
   Part 1〜3 統合フルコード（質問モード完全対応）
====================================================== */

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* ==========================
   環境変数
========================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ==========================
   LINE SDK クライアント
========================== */
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* ======================================================
   🔥 グローバルでユーザー状態を保存する
====================================================== */
const userState = {}; 
// userState[userId] = { mode: "question" | "lecture" | "practice" | "chat" }

/* ======================================================
   Webhook 設定
====================================================== */
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
      console.error("Webhook ERROR:", err);
      res.status(200).end();
    }
  }
);

/* ======================================================
   🧠 メインイベント処理
====================================================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  const msg = event.message;

  // ユーザー状態初期化
  if (!userState[userId]) {
    userState[userId] = { mode: "none" };
  }

  const currentMode = userState[userId].mode;

  /* ============================
     画像 → 質問モード扱い
  ============================ */
  if (msg.type === "image") {
    return handleImageQuestion(event, userId);
  }

  /* ============================
     テキスト処理
  ============================ */
  if (msg.type === "text") {
    const text = msg.text.trim();

    /* ---- あいさつ → メニュー ---- */
    if (isGreeting(text)) {
      return sendGreetingMenu(event.replyToken);
    }

    /* ---- いまのモードごとの処理 ---- */
    if (currentMode === "question") {
      return handleTextQuestion(event, userId);
    }

    // Part4（講義）は後で追加する
    if (currentMode === "lecture") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "講義モードはまだ準備中だよ🐻✨\n次のアップデートで実装するね！",
      });
    }

    // Part5（演習）は後で追加する
    if (currentMode === "practice") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "演習モードは準備中だよ🐻🔥\nもう少し待っててね！",
      });
    }

    if (currentMode === "chat") {
      return handleChat(event, userId);
    }

    /* ---- モードが未設定なら自然言語から判定 ---- */
    const detected = detectModeFromText(text);

    if (detected) {
      userState[userId].mode = detected;
      return sendModeStartMessage(detected, event.replyToken);
    }

    /* ---- どれにも該当しなければメニューへ ---- */
    return sendGreetingMenu(event.replyToken);
  }
}

/* ======================================================
   🐻 あいさつ判定
====================================================== */
function isGreeting(text) {
  return (
    text.includes("こんにちは") ||
    text.includes("こん") ||
    text.includes("はじめまして") ||
    text.includes("やあ") ||
    text.includes("おはよ") ||
    text.includes("こんばんは")
  );
}

/* ======================================================
   🐻 メニュー表示
====================================================== */
function sendGreetingMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "・質問したい\n" +
      "・講義してほしい\n" +
      "・演習したい\n" +
      "・雑談したい\n\n" +
      "やりたいことをそのまま送ってね！",
  });
}

/* ======================================================
   Part 2：自然文 → モード判定
====================================================== */
function detectModeFromText(text) {
  if (
    text.includes("質問") ||
    text.includes("教えて") ||
    text.includes("わからない") ||
    text.includes("解説") ||
    text.includes("聞きたい")
  ) {
    return "question";
  }

  if (
    text.includes("講義") ||
    text.includes("授業") ||
    text.includes("説明してほしい")
  ) {
    return "lecture";
  }

  if (
    text.includes("演習") ||
    text.includes("問題") ||
    text.includes("練習")
  ) {
    return "practice";
  }

  if (
    text.includes("雑談") ||
    text.includes("話そう") ||
    text.includes("相談")
  ) {
    return "chat";
  }

  return null;
}

/* ======================================================
   モード開始メッセージ
====================================================== */
async function sendModeStartMessage(mode, replyToken) {
  if (mode === "question") {
    return client.replyMessage(replyToken, {
      type: "text",
      text:
        "いいね！質問モードだよ🐻✨\n\n" +
        "文章でも写真でもOK！\n好きな形で質問してね！",
    });
  }

  if (mode === "lecture") {
    return client.replyMessage(replyToken, {
      type: "text",
      text:
        "了解！講義モード📘✨\n\n" +
        "まずは教科（数学・物理・化学など）を教えてね！",
    });
  }

  if (mode === "practice") {
    return client.replyMessage(replyToken, {
      type: "text",
      text:
        "演習モードだよ📝🔥\n\n" +
        "教科とレベルを教えてくれたら問題を出すね！",
    });
  }

  if (mode === "chat") {
    return client.replyMessage(replyToken, {
      type: "text",
      text: "雑談モードだよ☕🐻✨\nなんでも話してみて！",
    });
  }
}

/* ======================================================
   Part 3：質問モード（テキスト）
====================================================== */
async function handleTextQuestion(event, userId) {
  const text = event.message.text.trim();

  if (text.length < 2) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "どんな質問かな？もう少し詳しく教えてね🐻✨",
    });
  }

  const prompt =
    "以下の質問を、優しく順番に、板書で説明する感じで解説してください。\n\n質問：" +
    text;

  const answer = await callGPT(prompt);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: answer,
  });
}

/* ======================================================
   GPT（テキスト質問用）
====================================================== */
async function callGPT(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content:
            "あなたは優しい先生くまお先生です。難しい言葉を避け、順番にわかりやすく説明します。",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

/* ======================================================
   画像質問（Vision）
====================================================== */
async function handleImageQuestion(event, userId) {
  userState[userId].mode = "question";

  const base64 = await getImageBase64(event.message.id);
  const instruction =
    "この画像の問題を、優しくわかりやすく、順番に解説してください。";

  const answer = await callVision(base64, instruction);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: answer,
  });
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

async function callVision(base64, instruction) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content:
            "あなたは優しい先生くまお先生です。順番に、かみくだいて説明します。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

/* ======================================================
   雑談モード（簡易）
====================================================== */
async function handleChat(event, userId) {
  const text = event.message.text;

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `うんうん🐻✨\n${text} について話そう！`,
  });
}

/* ======================================================
   起動
====================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生（質問モード統合版）起動中 🐻✨");
});
/* ======================================================
   Part 4：講義モード（科目 → 単元 → 講義 → ノート生成）
====================================================== */

/* ---------------------------------------------
   講義モードの流れを管理
   userState[userId].lecture = {
      subject: "",
      unit: ""
   }
--------------------------------------------- */
async function handleLectureFlow(event, userId) {
  const text = event.message.text.trim();

  // lecture 用の状態がなければ作成
  if (!userState[userId].lecture) {
    userState[userId].lecture = { subject: "", unit: "" };
  }

  const lecture = userState[userId].lecture;

  /* ----------------------
     ① 科目が未入力
  ---------------------- */
  if (!lecture.subject) {
    lecture.subject = text;
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `OK！「${lecture.subject}」だね📘✨\n` +
        "次に、学びたい単元を教えてね！（例：2次関数、微分、力学、酸化還元など）",
    });
  }

  /* ----------------------
     ② 単元が未入力
  ---------------------- */
  if (!lecture.unit) {
    lecture.unit = text;

    // 科目＋単元が揃ったら講義生成
    const prompt = `
あなたは優しい先生「くまお先生」です。

科目：${lecture.subject}
単元：${lecture.unit}

生徒向けに、やさしく、順番に、かみくだいて講義してください。

その後、以下のノートを必ず作ってください：

【今日のまとめ】
・授業で扱ったポイントを箇条書き

【ポイント】
・重要な公式、考え方、注意点を簡潔にまとめる

【解き方】
・計算問題の場合は 1⃣ 2⃣ 3⃣ … の順番で手順を示す
・必要なだけ手順を入れていい

【チェック問題】
・理解を確認するための簡単な練習問題を1問

語尾は必ず：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

    const answer = await callGPT(prompt);

    // 講義が終わったので lecture 状態リセット
    userState[userId].lecture = { subject: "", unit: "" };
    userState[userId].mode = "none";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });
  }
}
/* ======================================================
   Part 5：演習モード（問題出題 → 回答 → 採点 → 解説）
====================================================== */

/*
 userState[userId].practice = {
   subject: "",
   level: "",
   problem: "",  // 出題した問題文
   answer: ""    // 正解
 }
*/

async function handlePracticeFlow(event, userId) {
  const text = event.message.text.trim();

  // 状態が無ければ作る
  if (!userState[userId].practice) {
    userState[userId].practice = {
      subject: "",
      level: "",
      problem: "",
      answer: "",
    };
  }

  const p = userState[userId].practice;

  /* -------------------------------------------
     ① 科目がまだ
  ------------------------------------------- */
  if (!p.subject) {
    p.subject = text;
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `OK！「${p.subject}」の演習だね📝✨\n` +
        "次はレベルを教えてね！（基礎・標準・難関）",
    });
  }

  /* -------------------------------------------
     ② レベルがまだ
  ------------------------------------------- */
  if (!p.level) {
    p.level = text;

    // 問題生成プロンプト
    const prompt = `
あなたは「くまお先生」です。
生徒に向けて、${p.subject} の ${p.level} レベルの問題を 1 問だけ作ってください。

出力形式は必ず次に従う：

【問題】
ここに問題文

【答え】
ここに正解（数式1つ or 結論のみ）

解説は書かない。`;
    const result = await callGPT(prompt);

    // GPT から問題と答えを抽出
    const problem = result.match(/【問題】([\s\S]*?)【答え】/);
    const answer = result.match(/【答え】([\s\S]*)/);

    p.problem = problem ? problem[1].trim() : "問題取得エラー";
    p.answer = answer ? answer[1].trim() : "答え取得エラー";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "問題を作ったよ！🔥🐻\n\n" +
        "【問題】\n" +
        p.problem +
        "\n\n答えがわかったら送ってね！",
    });
  }

  /* -------------------------------------------
     ③ 生徒が回答を送った → 採点
  ------------------------------------------- */
  if (p.problem && p.answer) {
    const studentAnswer = text;

    const scoringPrompt = `
生徒の回答を採点してください。

【問題】
${p.problem}

【正解】
${p.answer}

【生徒の回答】
${studentAnswer}

出力形式：
【採点】
正解 or 不正解

【解説】
ていねいに解説

最後に次の問題を出す必要があるか判断して、一言添える。
`;

    const scoreResult = await callGPT(scoringPrompt);

    // 採点 & 解説の返信
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: scoreResult,
    });

    // 次の問題生成へ備えてリセット
    userState[userId].practice = {
      subject: p.subject,
      level: p.level,
      problem: "",
      answer: "",
    };

    return;
  }
}
