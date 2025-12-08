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

    // Part3 のテキストメッセージ処理内に追加する
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

  // その他
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨"
  });
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
あなたは優しい家庭教師の「くまお先生」です。

【ノートの作り方】
- 絵文字は使わず、板書のようにすっきり書く
- Markdown記号（#, *, -, > など）は使わない
- 「今日のまとめ」「ここがポイント」「例」の3部構成にする
- 生徒がノートに写しやすいようにシンプルな文章と数式で書く
- 数式は ( ), /, ^, √ を使う
- 必要なら「間違えやすいポイント」も追加する

【構成】
1. 今日のまとめ
2. ここがポイント
3. 例（必要な場合）

【冒頭文】
今日の大事なところをいっしょにまとめておくね！

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
// Part6: 画像 → 数学/物理/化学の問題解析エンジン（Bトーン仕様）
// ================================================

// 画像が届いた瞬間：まずは生徒に声かけして答えを聞く
async function handleImage(event) {
  const userId = event.source.userId;

  // ユーザー状態がまだ無い場合は作る
  if (!globalState[userId]) {
    globalState[userId] = {};
  }
  const state = globalState[userId];

  // STEP1: 先に「答えの有無を聞くメッセージ」を返す（Bトーン）
  await client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "画像ありがとう〜🐻✨ いま読んでいくね！\n" +
      "ところでね、もし“答え”が分かってたら教えてほしいんだ。\n" +
      "答えを知っていると、先生の解説がもっとピタッと合わせられるんだよ🔥\n\n" +
      "分かっていたらその答えをそのまま送ってね。\n" +
      "もし分からなかったら「わからない」で大丈夫だよ🐻💛"
  });

  // 画像データを先に保存しておく（あとで解析に使う）
  const stream = await client.getMessageContent(event.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  state.waitingImageAnswer = true;
  state.lastImageBase64 = b64;

  return;
}


// 生徒の返答をうけて画像解析スタート
async function handleImageAnswer(event, state) {
  const text = event.message.text.trim();
  const b64 = state.lastImageBase64;

  // YES（答え入力あり）
  if (text !== "わからない") {
    state.imageKnownAnswer = text;
  } else {
    state.imageKnownAnswer = null;
  }

  // ここで GPT-4.1 に画像解析させる
  const messages = [
    {
      role: "system",
      content:
        "あなたは『くまお先生』です。" +
        "画像の中の数学/物理/化学の問題を正確に読み取り、読みやすい文章にして説明します。" +
        "数式は全部 ( ), /, *, sqrt(), ^ を使ったプレーンテキストで書くこと。" +
        "Markdown記号（*, #, _, ~, >, `）は禁止。" +
        "くまお先生の丁寧で優しい話し方で、絵文字も適度に使う。" +
        "必ず、本当に授業しているような自然な流れで教えること。"
    },
    {
      role: "user",
      content: [
        { type: "text", text: "次の画像の問題を読み取って、丁寧に解説してね。" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    }
  ];

  // 答えが分かっている場合は GPT にヒントとして渡す
  if (state.imageKnownAnswer) {
    messages.push({
      role: "user",
      content:
        `生徒が答えとして「${state.imageKnownAnswer}」と言っています。` +
        "これを参考にしつつ、問題文の読み取りと解説を行ってください。"
    });
  }

  // GPT-4.1 で解析
  const aiText = await openaiChat(messages, "extreme"); // 4.1 を使用

  // 数式整形
  const finalText = sanitizeMath(aiText);

  // 完成した解説を返す
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: finalText
  });

  // 後処理
  state.waitingImageAnswer = false;
  state.lastImageBase64 = null;
  state.imageKnownAnswer = null;
}


// ================================================
// 画像回答ルーター
// ================================================
async function routeImageIfNeeded(event, state) {
  if (!state.waitingImageAnswer) return false;

  await handleImageAnswer(event, state);
  return true;
}

