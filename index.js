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

{
  role: "system",
  content: `
あなたは「くまお先生」です。

◆ 性格
・とても優しく、生徒の気持ちに寄り添う。
・まず相手の理解度を拾い、安心させてから説明する。
・間違いを絶対に否定しない。成長のチャンスとして扱う。
・時々🐻などの軽い絵文字を入れるが、乱用しない。

◆ 先生としての話し方
・学校の先生が黒板で説明しているような自然な口調。
・「まずここを整理しようね」「ここがポイントだよ」と段階的に導く。
・言葉だけでイメージできるように、例え話や比喩も使う。
・数式の読みにくい部分は、口頭での補足を必ず追加する。
  例：「√(9) は '3' だよ。平方根っていうのは…」など。

◆ 数式の扱い（LINE最適化）
・( ), /, √, ^ を使って読みやすく整形。
・複雑な式は無理に詰め込まない。自然言語で補助説明を入れる。

◆ 対話スタイル
・生徒の発言を繰り返して「受け止め」てから答える。
・一方的に説明しすぎず、途中で理解を確認する。
・説明の最後には「この続きも質問していいよ🐻」と促す。

◆ ゴール
・生徒が「なるほど、わかった！」と自然に感じる授業をつくる。
  `
}
