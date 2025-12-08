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
// Part3: FREEモードのメインルーター
// ================================================
async function handleEvent(event) {
  const userId = event.source.userId;

  // 初回設定
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      lastTopic: null,
      lastAnswer: null,
      exercise: null,
    };
  }

  const state = globalState[userId];

  // 画像 → 数学/物理/化学の解析へ
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  // テキスト
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // ▼ 強制メニュー
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      return replyMenu(event.replyToken);
    }

    // ▼ 演習モード中なら優先
    if (state.exercise && state.exercise.step === 1) {
      return handleExerciseMode(event, state);
    }

    // ▼ 通常FREEモードの対話処理
    return handleFreeText(event, state);
  }

  // その他
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻",
  });
}

// ================================================
// Part4: FREEモード — くまお先生の思考エンジン
// ================================================

async function handleFreeText(ev, state) {
  const text = ev.message.text.trim();

  // 特別コマンド：ノートまとめ
  if (text === "ノートまとめて") {
    if (!state.lastTopic || !state.lastAnswer) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まずは一緒に勉強して、その内容をわかりやすくまとめるね🐻📘"
      });
    }

    const summary = await openaiChat([
      {
        role: "system",
        content: `
あなたは「くまお先生」です。
生徒があとで見返しやすいように、
・要点
・大事な式
・注意ポイント
をシンプルで優しくまとめる“ノート職人”として振る舞ってください。

絵文字は控えめに 🐻 を時々使うだけ。
`
      },
      {
        role: "user",
        content: `この内容をノート用にまとめて：\n${state.lastAnswer}`
      }
    ]);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "📘 **くまお先生のまとめノートだよ**\n\n" + summary
    });
  }

  // 特別コマンド：演習モード
  if (text === "演習したい") {
    return sendExerciseQuestion(ev, state);
  }

  // ---------------------------------------
  // 普通の質問（FREE学習モード）
  // ---------------------------------------
  const response = await openaiChat(
    [
      {
        role: "system",
        content: `
あなたは優しく寄り添う「くまお先生」です。

◆ 性格
・生徒の気持ちに寄り添いながら教える。
・否定しない、安心させる言葉を自然に入れる。
・わからない時は例え話や別の角度から説明する。
・🐻の絵文字をときどき使う（多用はしない）。

◆ 説明の仕方
・学校の先生のように黒板で説明している自然な話し方。
・「ここが大事だよ」「これは気をつけようね」と要点をまとめる。
・数式はLINEで読める形に整形する（√, /, ^, () など）。
・難しい式は、言葉の説明も添えて理解しやすくする。

◆ 禁止事項
・ChatGPTらしい表現は禁止。
・** や Markdown を使いすぎるのも禁止。
・急に専門家みたいな冷たい口調になるのは禁止。

◆ ゴール
生徒が「なるほど、わかった！」と自然に感じられること。
最後は必ず「つづけて質問してもいいよ🐻」と声をかける。
`
      },
      {
        role: "user",
        content: text
      }
    ],
    "normal" // ← 標準学習モデル
  );

  // 記録（ノート用）
  state.lastTopic = text;
  state.lastAnswer = response;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: sanitizeMath(await response)
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
// Part6: 画像 → 数学/物理/化学の問題解析（完全安定版）
// ================================================

async function handleImage(ev) {
  const userId = ev.source.userId;

  // ---- 画像を取得（バイナリ→Base64） ----
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  // ---- GPTへ解析依頼 ----
  const response = await openaiChat(
    [
      {
        role: "system",
        content: `
あなたは優しく寄り添う「くまお先生」です。

◆ やること（3ステップ）
(1) 画像の数学・物理・化学の問題文を正確に読み取る  
(2) 生徒が理解しやすいように、段階的にやさしく説明する  
(3) 最後に必ず「【答え】〜」を一行で書く  

◆ 数式の書き方（LINE向け）
・分数： a/b  
・平方根： sqrt( )  
・累乗： x^2  
・かけ算： x * y  
・括弧は ( ) を使う  
※ LaTeX をそのまま出さないこと  

◆ 口調ルール
・学校の黒板で説明する先生のように丁寧でやさしい  
・適度に絵文字（🐻✨など）OK  
・ChatGPTっぽい言い方は禁止  
・急がず、ひとつずつ順を追って説明する  

`
      },
      {
        role: "user",
        content: [
          { type: "text", text: "この画像の問題を読み取って、わかりやすく解説してください。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
        ]
      }
    ],
    "hard" // ← 高精度モードで解析
  );

  const fixed = sanitizeMath(response);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: fixed
  });
}
