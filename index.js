// ================================================
// Part1: 基本セットアップ（LINE × OpenAI）
// ================================================
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
require("dotenv").config();

const app = express();

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// FREEモード1本
const globalState = {};

// ヘルスチェック
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

// Webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

// サーバー起動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running:", port));


// ================================================
// Part2: OpenAI（難易度によるモデル切替）
// ================================================
async function openaiChat(messages, level = "normal") {
  try {
    let model = "gpt-4o-mini";

    if (level === "normal") model = "gpt-4o";
    if (level === "hard") model = "gpt-4o-turbo";
    if (level === "extreme") model = "gpt-4.1";

    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model,
        temperature: 0.4,
        messages
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      }
    );

    return res.data.choices?.[0]?.message?.content;
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "GPTくん側でエラーが起きちゃったみたい💦 ごめんね…もう一度聞いてくれる？🐻";
  }
}



// ================================================
// Part3: FREEモードのイベントルーター
// ================================================
async function handleEvent(event) {
  const userId = event.source.userId;

  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      lastTopic: null,
      lastAnswer: null,
      exercise: null
    };
  }

  const state = globalState[userId];

  // 🎯 演習モードなら最優先で判定へ
  if (state.exercise) {
    return handleExerciseMode(event, state);
  }

  // 画像
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  // テキスト
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    if (text === "メニュー") {
      state.mode = "free";
      state.lastTopic = null;
      state.lastAnswer = null;
      return replyMenu(event.replyToken);
    }

    return handleFreeText(event, state);
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨"
  });
}



// ================================================
// Part4: FREEモード（くまお先生の人格エンジン）
// ================================================
async function handleFreeText(ev, state) {
  const text = ev.message.text.trim();

  // ------------------------------------------------
  // ノートまとめ
  // ------------------------------------------------
  if (text === "ノートまとめて") {
    if (!state.lastTopic) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まず何について学んだか教えてね🐻📘"
      });
    }

    const summary = await openaiChat([
      {
        role: "system",
        content:
          "あなたは優しく丁寧なノート職人くまお先生です。重要ポイントを中学生でも写せる形で簡潔にまとめてください。"
      },
      {
        role: "user",
        content: `生徒と話した内容:\n${state.lastTopic}`
      }
    ]);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "📘 **くまお先生のまとめノート**\n" + summary
    });
  }

  // ------------------------------------------------
  // 演習
  // ------------------------------------------------
  if (text === "演習したい") {
    return sendExerciseQuestion(ev, state);
  }

  // ------------------------------------------------
  // 普通の質問 → くまお先生が回答
  // ------------------------------------------------
  const response = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく寄り添う「くまお先生」です。

◆ 性格
・とにかく優しい
・生徒に安心感を与える
・否定しない

◆ 話し方
・学校の黒板で説明している先生の口調
・例え話多め
・理解を確認しながら進める
・🐻 は控えめに使用

◆ 数式
・LINEで崩れない文字を使う（√, /, ^）
・読みにくい式は口頭説明を添える

◆ 最後に必ずひとこと
「つづけて質問してもいいよ🐻」
`
    },
    { role: "user", content: text }
  ]);

  state.lastTopic = text;
  state.lastAnswer = response;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: response
  });
}



// ================================================
// Part5: 演習モード（1問 → 判定）
// ================================================
async function sendExerciseQuestion(ev, state) {
  const question = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しいくまお先生です。
中高生向けの数学・物理・化学からランダムで短く明確な演習問題を1問だけ作り、
「問題文のみ」を返してください。
`
    }
  ]);

  state.exercise = {
    step: 1,
    question,
    answer: null
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "📘 **演習問題だよ！**\n\n" + question + "\n\n解けたら答えを送ってね🐻"
  });
}


// 生徒が答えた時
async function handleExerciseMode(ev, state) {
  const text = ev.message.text.trim();

  if (state.exercise.step === 1) {
    state.exercise.answer = text;
    state.exercise.step = 2;
    return judgeExercise(ev, state);
  }
}


// 判定
async function judgeExercise(ev, state) {
  const q = state.exercise.question;
  const a = state.exercise.answer;

  const evaluation = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく寄り添うくまお先生です。
生徒の回答を判定し、JSON形式で返してください。

出力形式:
{
 "correct": true/false,
 "explanation": "ていねいな日本語説明"
}
`
    },
    { role: "user", content: `問題: ${q}\n生徒の答え: ${a}` }
  ]);

  let ai;
  try {
    ai = JSON.parse(evaluation);
  } catch {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "判定が少し乱れちゃったみたい💦 もう1度答えを送ってね🐻"
    });
  }

  state.exercise = null;

  if (ai.correct) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "💮 **正解！！すごいね！**\n\n" +
        ai.explanation +
        "\n\n次どうする？\n・「もう1問！」\n・「難しめ！」\n・「メニュー」"
    });
  }

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "🐻💛 間違えても大丈夫。ここからもっと伸びるよ。\n\n" +
      ai.explanation +
      "\n\n次どうする？\n・「もう1問！」\n・「難しめ！」\n・「メニュー」"
  });
}



// ================================================
// Part6: 画像解析エンジン（数学/物理/化学）
// ================================================
async function handleImage(ev) {
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  const b64 = Buffer.concat(chunks).toString("base64");

  const response = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しいくまお先生です。
画像の数学/物理/化学の問題を読み取り、以下の3ステップで説明してください。

1. 問題文を書き起こす
2. 解き方を丁寧に説明
3. 最後に「【答え】xxx」と一行で示す

LINEで崩れない数式表現に必ず変換すること。
`
    },
    {
      role: "user",
      content: [
        { type: "text", text: "この画像の問題を解説してください。" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    }
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: sanitizeMath(response)
  });
}



// ================================================
// 数式整形フィルタ sanitizeMath
// ================================================
function sanitizeMath(text = "") {
  if (!text) return "";

  let s = text;

  // LaTeX消し
  s = s.replace(/\$/g, "");

  // 分数
  s = s.replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)");

  // √
  s = s.replace(/\\sqrt{([^}]+)}/g, "√($1)");

  // 指数
  s = s.replace(/\\^\\{([^}]+)}/g, "^$1");
  s = s.replace(/([A-Za-z0-9]+)\^([A-Za-z0-9]+)/g, "$1^$2");

  // 掛け算
  s = s.replace(/\\cdot/g, "×");

  // 割り算
  s = s.replace(/\\div/g, "÷");

  // ±
  s = s.replace(/\\pm/g, "±");

  // Σ
  s = s.replace(/\\sum_{([^}]+)}\^{([^}]+)}/g, "Σ($1→$2)");

  // ∫
  s = s.replace(/\\int_{([^}]+)}\^{([^}]+)}/g, "∫($1→$2)");

  return s.trim();
}



// ================================================
// メニュー（任意）
// ================================================
function replyMenu(token) {
  return client.replyMessage(token, {
    type: "text",
    text:
      "🐻 くまお先生だよ！どうする？\n\n" +
      "・なんでも質問する\n" +
      "・演習したい\n" +
      "・ノートまとめて\n\n" +
      "自由に話しかけてね✨"
  });
}
