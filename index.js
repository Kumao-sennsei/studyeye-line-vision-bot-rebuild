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
// Part2: OpenAI 共通処理（壊れない超シンプル版）
// ================================================
async function callOpenAI(messages) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",     // 軽くて速い
        temperature: 0.4,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return res.data.choices?.[0]?.message?.content || "返事が読み取れなかったよ💦";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "OpenAIとの通信でエラーが発生しちゃったよ🐻💦";
  }
}

// ================================================
// Part3: FREEモードのイベントルーター（超シンプル）
// ================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // ユーザー状態がなければ初期化
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      lastAnswer: null,
      lastTopic: null,
    };
  }

  const state = globalState[userId];

  // 画像メッセージ → 数学/物理/化学の問題解析へ
  if (event.type === "message" && event.message.type === "image") {
    return handleImage(event);
  }

  // テキストメッセージ
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    // 強制メニューコマンド（どのモードでも発動）
    if (text === "メニュー") {
      state.mode = "free";
      state.lastTopic = null;
      state.lastAnswer = null;
      return replyMenu(event.replyToken);
    }

    // 通常の FREE 対話処理
    return handleFreeText(event, state);
  }

  // その他（スタンプ等）
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨",
  });
}

// ================================================
// Part4: FREEモード（くまお先生の思考エンジン）
// ================================================

async function handleFreeText(ev, state) {
  const text = ev.message.text.trim();

  // ---------------------------------------
  // 特別コマンド
  // ---------------------------------------
  if (text === "ノートまとめて") {
    if (!state.lastTopic) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まず何について学んだか教えてね🐻📘"
      });
    }

    const summary = await openaiChat([
      { role: "system", content: "あなたは優しく丁寧なノート作りの名人くまお先生です。重要ポイントを簡潔にまとめて、生徒が写しやすいノートを作ってください。" },
      { role: "user", content: `生徒と話した内容:\n${state.lastTopic}` }
    ]);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "📘 **くまお先生のまとめノート**\n" + summary
    });
  }

  if (text === "演習したい") {
    return sendExerciseQuestion(ev, state);
  }

  // ---------------------------------------
  // 普通の質問 → くまお先生が丁寧に回答
  // ---------------------------------------
  const response = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく丁寧に教える「くまお先生」です。

【会話ルール】
- ChatGPTっぽさを出してはダメ
- 先生が黒板を使って教えているような自然な話し方にする
- 数式が読みにくい場合は「言葉で噛み砕いた説明」を追加する
- 例え話もOK
- 生徒への共感・励まし多め
- 最後に「つづけて質問してもいいよ🐻」と促す

【目的】
生徒の理解度に合わせて自然に対話しながら教える。
      `
    },
    {
      role: "user",
      content: text
    }
  ]);

  // 記録しておく（あとでノート化などに使う）
  state.lastTopic = text;
  state.lastAnswer = response;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: response
  });
}
// ================================================
// Part5: 演習モード（1問 → 解答 → 判定）
// ================================================

// 生徒が「演習したい」と言ったら呼ばれる
async function sendExerciseQuestion(ev, state) {
  // GPTにランダムで1問作らせる
  const question = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく丁寧に教える「くまお先生」です。
中高生向けに、数学・物理・化学からランダムで短く明確な演習問題を1問だけ出してください。
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
    text:
      "📘 **演習問題だよ！**\n\n" +
      question +
      "\n\n解けたら答えを送ってね🐻✨"
  });
}


// 生徒が答えを送ったら判定する
async function handleExerciseMode(ev, state) {
  const text = ev.message.text.trim();

  // -----------------------
  // STEP1：回答を受け取る
  // -----------------------
  if (state.exercise.step === 1) {
    state.exercise.answer = text;
    state.exercise.step = 2;

    return judgeExercise(ev, state);
  }
}


// 判定エンジン
async function judgeExercise(ev, state) {
  const q = state.exercise.question;
  const a = state.exercise.answer;

  const evaluation = await openaiChat([
    {
      role: "system",
      content: `
あなたは優しく丁寧に寄り添う「くまお先生」です。

【目的】
生徒の回答が合っているか判定し、
合っていたら褒めて、間違えていたらスーパーくまお先生で丁寧に励ましながら教える。

【出力形式】
{
 "correct": true/false,
 "explanation": "くまお先生の説明文（やさしい口調・例えOK）"
}
`
    },
    {
      role: "user",
      content: `問題：${q}\n生徒の答え：${a}`
    }
  ]);

  let ai;
  try { ai = JSON.parse(evaluation); }
  catch {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "判定がちょっと乱れちゃった💦 もう一度答え送れる？🐻"
    });
  }

  // 正解
  if (ai.correct) {
    state.exercise = null; // 終了

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "💮 **正解！！すごいね！**\n\n" +
        ai.explanation +
        "\n\n次どうする？\n・「もう1問！」\n・「難しめ！」\n・「メニュー」"
    });
  }

  // 不正解：スーパーくまお先生で励まし
  state.exercise = null;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "🐻💛 だいじょうぶ。間違えるのは成長のチャンスだよ。\n\n" +
      ai.explanation +
      "\n\n次どうする？\n・「もう1問！」\n・「難しめ！」\n・「メニュー」"
  });
}

