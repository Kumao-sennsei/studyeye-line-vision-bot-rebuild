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

// ユーザー状態（FREEモード1本）
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
// Part2: OpenAI共通処理（モデル自動切り替え）
// ================================================
async function openaiChat(messages, level = "normal") {
  try {
    // ▼ 難易度に応じてモデル切替
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
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const out = res.data.choices?.[0]?.message?.content;
    if (!out) {
      return "うまく答えを取り出せなかったみたい…もう一度だけ聞いてみてくれる？🐻";
    }

    return out;

  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);

    // ▼ エラー時も “くまお先生” として優しく返す
    return (
      "GPTくん側でちょっとつまずいちゃったみたい…💦\n" +
      "心配しないでね、もう一度質問してくれたら大丈夫だよ🐻"
    );
  }
}
// ================================================
// 数学整形フィルタ（LINE向け・読みやすさ最優先）
// ================================================
function sanitizeMath(text = "") {
  if (!text) return "";

  let t = text;

  // LaTeX系の記号を全部 LINE向けへ変換
  t = t.replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)");
  t = t.replace(/\\sqrt{([^}]+)}/g, "√($1)");
  t = t.replace(/\\times/g, "×");
  t = t.replace(/\\cdot/g, "×");
  t = t.replace(/\\div/g, "÷");
  t = t.replace(/\\pi/g, "π");

  // 上付き・下付き
  t = t.replace(/\^\{([^}]+)\}/g, "^($1)");
  t = t.replace(/_([^} ])/g, "_$1");

  // ∑, ∫ などを自然言語へ
  t = t.replace(/\\sum/g, "Σ");
  t = t.replace(/\\int/g, "∫");

  // 不要なバックスラッシュ除去
  t = t.replace(/\\[A-Za-z]+/g, "");

  // LaTeX の $$ や $ を削除
  t = t.replace(/\$\$/g, "");
  t = t.replace(/\$/g, "");

  // ChatGPTっぽい **太字** を禁止 → 普通の強調へ
  t = t.replace(/\*\*(.*?)\*\*/g, "$1");

  // 読みにくいときの補助文を自動追加（ただし1度だけ）
  if (/[\^√Σ∫]/.test(t) && !t.includes("（読み方）")) {
    t += "\n\n（読みづらい式は、先生が口で補足するから安心してね🐻）";
  }

  return t;
}

// ================================================
// Part3: FREEモードのイベントルーター（完成版）
// ================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // 初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null
    };
  }

  const state = globalState[userId];

  // -------------------------
  // 画像 → 画像解析へ
  // -------------------------
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  // -------------------------
  // テキスト
  // -------------------------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // メニュー
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      return replyMenu(event.replyToken);
    }

    // 演習モード中（回答の判定へ）
    if (state.exercise && state.exercise.step === 1) {
      return handleExerciseMode(event, state);
    }

    // 通常の FREE 対話
    return handleFreeText(event, state);
  }

  // その他
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨"
  });
}


// ================================================
// Part4: FREEモード（くまお先生の思考エンジン・最新版）
// ================================================

async function handleFreeText(ev, state) {
  const text = ev.message.text.trim();

  // ---------- 特別コマンド ----------
  if (text === "ノートまとめて") {
    if (!state.lastTopic || !state.lastAnswer) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まず何について話したか教えてね🐻📘"
      });
    }

    const note = await openaiChat([
      {
        role: "system",
        content: `
あなたは優しく丁寧に教える「くまお先生」です。

【目的】
生徒が「そのままノートに写せるまとめ」を作る。

【ノートの書き方】
・☆重要☆ → 大事な考え方
・★テストによく出る★ → 試験ポイント
・●ポイント → 手順やコツ
・語尾は柔らかく
・絵文字は適度に（🐻📘✨ を中心に）

【禁止】
・Markdown記号（#, *, _, ~, >, \`, ```）
・ChatGPT的ワード（計算機を用いて、など）

【出力】
ノート本文のみ。
`
      },
      {
        role: "user",
        content: `
話題：${state.lastTopic}

くまお先生の説明：
${state.lastAnswer}
`
      }
    ]);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: note + "\n\n必要なところはノートに写しておこうね🐻📘"
    });
  }

  if (text === "演習したい") {
    return sendExerciseQuestion(ev, state);
  }


  // ---------- 通常の質問 → くまお先生回答 ----------
  const response = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく丁寧に寄り添う「くまお先生」です。

【話し方】
・黒板を前に授業している自然な口調
・例え話や図形を言葉で説明する
・生徒の理解を確認しながら進める
・絵文字は控えめ（🐻✨📘）
・難しい式は「言葉で噛み砕いた説明」を必ず追加する

【ノート表現】
説明の途中に、
・☆重要☆
・★テストによく出る★
・●ポイント
を自然に混ぜてよい。

【数式】
LINEで崩れない形で書く：
・√( )
・( )/( )
・×, ÷
・^ を使う
・分数は (a)/(b)
・Markdown系禁止（#, *, _, ~, ``` 等）
・禁止ワード「計算機を用いて」

【目的】
・生徒が「わかった！」を自然に感じる授業をすること
・必要なら「ノートまとめて」と誘導しても良い

授業開始。
`
    },
    { role: "user", content: text }
  ]);

  // 記録
  state.lastTopic = text;
  state.lastAnswer = response;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: sanitizeMath(response) + "\n\nつづけて質問してもいいよ🐻"
  });
}

// ================================================
// Part5: 演習モード（1問 → 解答受付 → 判定）
// ================================================

// 生徒が「演習したい」と言ったら呼ばれる
async function sendExerciseQuestion(ev, state) {

  // 質問が暴走しないよう exercise を初期化
  state.exercise = {
    step: 1,
    question: null,
    answer: null
  };

  const question = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しい「くまお先生」です。
中高生向けに、数学・物理・化学のどれかの
・短くて
・シンプルで
・数式が崩れない
演習問題を1問だけ出してください。

LaTeXは禁止。√, /, ^, () を使ってください。
問題文のみを返してください。
`
    }
  ], "normal");

  state.exercise.question = question;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "📘 **演習問題だよ！**\n\n" +
      sanitizeMath(question) +
      "\n\n解けたら答えを送ってね🐻"
  });
}


// テキスト受信時 → 演習の場合はこちらに入る
async function handleExerciseMode(ev, state) {
  const text = ev.message.text.trim();

  // エラー避け：万一 exercise が空ならFREEモードへ
  if (!state.exercise || !state.exercise.question) {
    return handleFreeText(ev, state);
  }

  // STEP1：生徒の答えを保存し判定へ
  if (state.exercise.step === 1) {
    state.exercise.answer = text;
    state.exercise.step = 2;
    return judgeExercise(ev, state);
  }

  // STEP2：ここに来ることは基本的にない
  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "もう一度答えを送ってくれる？🐻"
  });
}



// 判定エンジン（安定版）
async function judgeExercise(ev, state) {
  const q = state.exercise.question;
  const a = state.exercise.answer;

  const evaluation = await openaiChat([
    {
      role: "system",
      content: `
あなたは「くまお先生」です。

【目的】
生徒の回答が正しいかを優しく判定し、
・正解 → 褒める
・不正解 → 丁寧に教え直す

【出力形式（絶対に守る）】
{
 "correct": true または false,
 "explanation": "やさしい口調で、途中式や考え方を言葉で教える"
}

※ LaTeX禁止。√, /, ^ を使用する。
※ ChatGPTっぽい口調禁止。やさしい先生。
`
    },
    {
      role: "user",
      content: `問題: ${q}\n生徒の答え: ${a}`
    }
  ], "hard");

  let ai;
  try {
    ai = JSON.parse(evaluation);
  } catch (err) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "判定がうまくできなかったみたい💦 もう一度答えを送ってみてね🐻"
    });
  }

  // 次の演習に備えて初期化
  state.exercise = null;

  // 正解
  if (ai.correct) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "💮 **正解！とってもよくできたね！**\n\n" +
        sanitizeMath(ai.explanation) +
        "\n\n次どうする？\n・もう1問！\n・難しめ！\n・メニュー"
    });
  }

  // 不正解
  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "🐻💛 大丈夫だよ、間違えたところから伸びていくんだよ。\n\n" +
      sanitizeMath(ai.explanation) +
      "\n\n次どうする？\n・もう1問！\n・難しめ！\n・メニュー"
  });
}
// ================================================
// Part6: 画像 → 数学/物理/化学の問題解析エンジン（完全版）
// ================================================

// 画像使用枚数カウンタ（1日ごとにリセット）
const imageCount = {};

// JST日付を取得する関数
function getJSTDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function handleImage(ev) {
  const userId = ev.source.userId;
  const today = getJSTDateString();

  // カウント初期化（新しい日ならリセット）
  if (!imageCount[userId] || imageCount[userId].date !== today) {
    imageCount[userId] = { date: today, used: 0 };
  }

  // 1日の上限チェック
  if (imageCount[userId].used >= 10) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "今日の画像質問は上限に達しちゃったみたいだよ🐻💦\n" +
        "また明日なら何枚でも送れるからね！"
    });
  }

  // カウント増加
  imageCount[userId].used++;

  // 画像バイナリ取得
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  // GPT4.1 で画像解析
  const response = await openaiChat(
    [
      {
        role: "system",
        content: `
あなたは、優しく丁寧に寄り添う「くまお先生」です。

【会話ルール】
- Markdown記号（#, *, _, ~, >, \`, ``` など）は一切使わない。
- 数式は LINE 向けに ( ), /, ×, ÷, √, ^ を使う。
- 見づらい式には、先生の口頭説明を追加する。
- 生徒が安心する口調でゆっくり説明する。

【画像解析の手順】
1. 問題文を読み取る
2. 解くための手順を丁寧に説明する
3. 最後に必ず一行で 【答え】〜 を書く

【禁止】
- 「計算機を用いて」など ChatGPT 特有の表現は禁止
- 「Markdown」やコードブロック表現は禁止

とにかく生徒が安心して理解できる説明をすること。
      `
      },
      {
        role: "user",
        content: [
          { type: "text", text: "この画像の問題を読み取って、優しく説明してください。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
        ]
      }
    ],
    "extreme" // gpt-4.1 を使用
  );

  const text = sanitizeMath(response);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text
  });
}
