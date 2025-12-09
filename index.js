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

if (event.type === "message" && event.message.type === "text") {
  const text = event.message.text.trim();

  // Part3 のテキストメッセージ処理内に追加する
  if (await routeImageIfNeeded(event, state)) {
    return;
  }
}
// ================================================================
// Part3: FREEモードのイベントルーター（最新版・完全動作版）
// ================================================================

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

  // ----------------------------------------------------
  // 画像 → 画像解析へ（答えあり／答えなしの振り分けはここ）
  // ----------------------------------------------------
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event, state);
  }

  // ----------------------------------------------------
  // テキスト
  // ----------------------------------------------------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // （追加）画像回答モードへの分岐
    if (await routeImageIfNeeded(event, state)) {
      return;
    }

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
}

// ================================================
// Part4: FREEモード（くまお先生の思考エンジン）
// ================================================

async function handleFreeText(ev, state) {
  const text = ev.message.text.trim();

  // -----------------------
  // 特別コマンド：ノートまとめ
  // -----------------------
  if (text === "ノートまとめて") {
    if (!state.lastTopic) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まず何について学んだか教えてね🐻✨"
      });
    }

    const note = await openaiChat([
 {
  role: "system",
  content: `
あなたは「くまお先生」です。

◆ 性格
・とても優しく、生徒の気持ちに寄り添う。
・相手の理解度に合わせて丁寧に調整する。
・間違いを否定しない。成長のチャンスとして扱う。
・ときどき 🐻 や ✨ などの絵文字を使って、雰囲気を和らげる。

◆ 話し方
・学校の先生が黒板で説明しているような自然な口調。
・「まずここを整理しようね」「ここがポイントだよ！」のように段階的に導く。
・言葉だけでイメージできるように、例え話や噛み砕いた説明を多めに入れる。
・数式や記号が続くときは、「これは〜を意味しているよ」と口頭で補足も入れる。
・Markdown記号（**, ##, ``` など）は使わない。プレーンテキストだけで書く。

◆ 生徒の「答え付き」メッセージへの対応
・生徒が「答えは〜だと思う」「(1) は 3/2 です」「これで合ってる？」のように、
  自分の答えを書いてきた場合は、次の順番で返事をする：

  1. その答えが正しいかどうかをはっきり伝える（正解 / ほぼ正解 / 惜しい / 別の答え）。
  2. できているところを必ず褒める。
  3. 間違っている場合は、「どこでずれたか」をステップを追って優しく説明する。
  4. 必要に応じて、似たタイプのミニ問題を1問だけ出して、理解を確認する。
     （生徒が疲れていそうなら無理に出さなくてもよい）

◆ 数式の書き方
・LINEでも読めるように ( ), /, ^, sqrt() を使ったテキスト形式で書く。
  例：x^2 + 3x - 2 = 0,  sqrt(3) / 2  など。
・式が読みづらくなりそうなときは、途中で言葉による説明を足す。

◆ 今日のまとめ・ノート
・授業の終わりや区切りがよいところでは、
  「今日のまとめ！」のような形で要点を箇条書きに整理する。
・「ここがポイント！」として、テストに出やすいところ・間違えやすいところを
  一言でまとめる。
・必要に応じて「ノートに写しておこうね！」と優しく声かけをする。

◆ 対話スタイル
・必ず最初に、生徒が送ってきた内容を受け止めてから説明を始める。
  例：「いいね、その考え方！」「その質問はとてもいいところに気付いているよ」など。
・一方的に長くしゃべりすぎず、ときどき様子をうかがう。
  例：「ここまでで大丈夫そう？」「どこが一番もやもやしている？」など。
・最後はやさしく「つづけて質問してもいいよ🐻✨」と促す。
`
},
      {
        role: "user",
        content: state.lastTopic + "\n\n先生の前回の説明:\n" + state.lastAnswer
      }
    ]);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: note
    });
  }

  // -----------------------
  // 特別コマンド：演習
  // -----------------------
  if (text === "演習したい") {
    return sendExerciseQuestion(ev, state);
  }

  // -----------------------
  // ふつうの質問を処理（先生口調）
  // -----------------------
  const response = await openaiChat(
    [
      {
        role: "system",
        content: `
あなたは優しく寄り添う先生「くまお先生」です。

【性格】
- とても優しく、生徒の理解度に合わせて話す
- 否定しない励ましスタイル
- 共感を必ず入れる
- 例え話も使う

【話し方】
- 学校の先生が黒板を使って説明するような自然な口調
- 生徒の解答や疑問を受け止めてから説明する
- 数式は ( ), /, ^, √ を使ってシンプルにする
- 読みにくい数式は言葉で補足説明する
- 絵文字は控えめに（🐻✨ くらい）

【禁止】
- Markdown記号（#, *, _, >）は禁止
- ChatGPTっぽい機械文は禁止

【最後に】
- 必ず「つづけて質問してもいいよ🐻」を添える
`
      },
      { role: "user", content: text }
    ],
    "normal"
  );

  // 内容保存（ノートまとめで使う）
  state.lastTopic = text;
  state.lastAnswer = response;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: response
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
// Part6: 画像 → 数学/物理/化学の問題解析エンジン（答えアリ/ナシ対応）
// ================================================

async function handleImage(ev) {
  const userId = ev.source.userId;
  const state = globalState[userId];

  // 画像データ取得
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  // 生徒から答えをもらっているか？
  const studentAnswer = state.imageProvidedAnswer || null;

  // 使い終わったので初期化
  state.imageProvidedAnswer = null;

  // GPT へ渡すプロンプト（4.1使用）
  const messages = [
    {
      role: "system",
      content:
        "あなたは優しく丁寧に寄り添う『くまお先生』です。" +
        "画像の数式や問題文を正確に読解し、LINEで読みやすいプレーンテキストで解説します。" +
        "数式は必ず *(), /, ^, sqrt()* を使ったテキスト形式にすること。" +
        "Markdownは禁止。" +
        "板書のように丁寧にステップで説明し、最後に『つづけて質問してもいいよ🐻✨』をつけてください。"
    },
    {
      role: "user",
      content: [
        { type: "text", text: studentAnswer
            ? `この画像の問題を読み取って、生徒の答え ${studentAnswer} が合っているかも踏まえて説明してください。`
            : "この画像の問題を読み取って、優しく丁寧に解説してください。" 
        },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    }
  ];

  // GPT-4.1 で解析
  const ai = await openaiChat(messages, "extreme"); // ← 画像なので最強モード

  // 整形して返答
  const cleaned = sanitizeMath(ai);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: cleaned
  });
}
