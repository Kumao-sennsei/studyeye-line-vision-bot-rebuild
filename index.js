// ================================================
// StudyEye くまお先生ボット - 完全フルコード（index.js）
// ES Modules / Railway / LINE Messaging API / OpenAI
// ================================================

import express from "express";
import line from "@line/bot-sdk";
import fetch from "node-fetch";

// -----------------------------------------------
// LINE Bot 設定
// -----------------------------------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn("⚠️ CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET が設定されていません");
}

const client = new line.Client(config);

// -----------------------------------------------
// Express 初期化
// -----------------------------------------------
const app = express();
app.use(express.json());

// -----------------------------------------------
// グローバル state（ユーザー別）
// -----------------------------------------------
/*
  globalState[userId] = {
    mode: "free",           // "free" | 将来: "exercise" など
    exercise: null,         // 今回は未実装（将来拡張用）
    lastTopic: null,
    lastAnswer: null,
    waitingAnswer: null,    // { kind: "image", status: "waiting_student_answer", imageBase64: "..." }
  };
*/
const globalState = {};

function getUserState(userId) {
  if (!globalState[userId]) {
    globalState[userId] = {
      mode: "free",
      exercise: null,
      lastTopic: null,
      lastAnswer: null,
      waitingAnswer: null,
    };
  }
  return globalState[userId];
}

// -----------------------------------------------
// 数式・テキスト整形（sanitizeMath）
// 仕様書の「板書スタイル」「Markdown禁止」に対応
// -----------------------------------------------
function sanitizeMath(text) {
  if (!text) return "";

  let t = text;

  // ChatGPT 的な Markdown 記号を削除
  t = t.replace(/[#$*_`>]/g, "");

  // 連続空行を詰める
  t = t.replace(/\n{3,}/g, "\n\n");

  // × ÷ を分かりやすく
  t = t.replace(/×/g, " x ");
  t = t.replace(/÷/g, " / ");

  // 全角スペースなどを軽く整形
  t = t.replace(/\u3000/g, " ");

  return t.trim();
}

// -----------------------------------------------
// OpenAI 共通設定（モデル切り替えロジックの土台）
// -----------------------------------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY が設定されていません");
}

// テキストモデル（通常／軽量）
const TEXT_MODEL_MAIN =
  process.env.OPENAI_TEXT_MODEL_MAIN || "gpt-4o";
const TEXT_MODEL_LIGHT =
  process.env.OPENAI_TEXT_MODEL_LIGHT || "gpt-4o-mini";

// Vision 用モデル（画像解析） ※仕様上 4.1 を推奨
const VISION_MODEL =
  process.env.OPENAI_VISION_MODEL || "gpt-4.1";

// 軽い問い合わせかどうかでモデルを分ける（超シンプル判定）
function chooseTextModel(userMessage) {
  if (!userMessage) return TEXT_MODEL_MAIN;
  if (userMessage.length <= 40) {
    return TEXT_MODEL_LIGHT; // 短い → 軽量モデル
  }
  return TEXT_MODEL_MAIN; // それ以外 → 通常
}

// -----------------------------------------------
// OpenAI: Chat テキスト呼び出し
// -----------------------------------------------
async function callOpenAIChat({ model, messages }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI Chat API error:", response.status, errorText);
    throw new Error("OpenAI Chat API error");
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  return sanitizeMath(content);
}

// -----------------------------------------------
// OpenAI: Vision 呼び出し
// -----------------------------------------------
async function callOpenAIVision({ imageBase64, instructions }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "system",
          content:
            "あなたは数学・物理・化学の問題を黒板で解説する優しい先生くまおです。板書スタイルで、読みやすく丁寧に日本語で説明します。Markdown記号(#, *, ** など)は一切使わないこと。「計算機を使います」とは書かないこと。",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: instructions,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI Vision API error:", response.status, errorText);
    throw new Error("OpenAI Vision API error");
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  return sanitizeMath(content);
}

// -----------------------------------------------
// LINE 返信ユーティリティ
// -----------------------------------------------
async function replyText(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: "text",
    text,
  });
}

// -----------------------------------------------
// 画像コンテンツ取得 → base64 変換
// -----------------------------------------------
async function getImageBase64(messageId) {
  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString("base64");
      resolve(base64);
    });
    stream.on("error", (err) => {
      console.error("getMessageContent error:", err);
      reject(err);
    });
  });
}

// =====================================================
// FREEモード（通常授業・質問）
// =====================================================
async function handleFreeText(event, state) {
  const userMessage = event.message.text.trim();
  const model = chooseTextModel(userMessage);

  const systemPrompt =
    "あなたは『くまお先生』です。優しく、寄り添いながら、高校生にも分かるように解説します。" +
    "ChatGPT風のMarkdown記号(#, *, **, ``` など)は使わず、板書のように1行ずつ丁寧に書きます。" +
    "数式は x^2, 3/4, √3 のようにLINEで読みやすい形で書いてください。" +
    "専門用語だけに頼らず、やさしい言葉で補足も入れてください。" +
    "「計算機を使います」という表現は使わないでください。";

  const userPrompt = [
    "【生徒の質問】",
    userMessage,
    "",
    "【出力ルール】",
    "・最初に「じゃあ、ここから一緒に見ていこうか🐻」のように一声かける",
    "・そのあと、板書風に1行ずつ説明する",
    "・必要なら途中で「ここは大事だよ」など一言コメントを入れる",
    "・最後に軽く背中を押す一言を入れる（例：『この問題、もう一度自分で解いてみると力になるよ🐻』）",
  ].join("\n");

  const answer = await callOpenAIChat({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  state.lastTopic = userMessage;
  state.lastAnswer = answer;

  return replyText(event.replyToken, answer);
}

// =====================================================
// 画像モード（答えあり・なし両対応）
// =====================================================

// ① 画像が送られたとき：まず答えを持っているかを聞く
async function handleImageFirst(event, state) {
  try {
    // LINE 側の画像保存期間があるので、このタイミングで取得＆保存しておく
    const imageBase64 = await getImageBase64(event.message.id);

    state.waitingAnswer = {
      kind: "image",
      status: "waiting_student_answer",
      imageBase64,
    };

    const text =
      "この問題、もし自分の答えがあったら送ってくれる？\n" +
      "一緒に答え合わせする方が精度が上がるよ🐻✨\n\n" +
      "・自分の答えを送る → 採点＆解説\n" +
      "・答えがなければ「そのまま解説して」と送ってくれたらOKだよ🐻";

    return replyText(event.replyToken, text);
  } catch (err) {
    console.error("handleImageFirst error:", err);
    return replyText(
      event.replyToken,
      "ちょっと調子が乱れちゃったみたい💦 もう一度画像を送ってくれる？"
    );
  }
}

// ② 生徒の答えが来たとき（答えあり） → 採点＆解説
async function handleImageWithStudentAnswer(event, state, studentAnswer) {
  try {
    if (
      !state.waitingAnswer ||
      state.waitingAnswer.kind !== "image" ||
      !state.waitingAnswer.imageBase64
    ) {
      // 念のためフォールバック：通常FREEモードに回す
      state.waitingAnswer = null;
      return handleFreeText(event, state);
    }

    const imageBase64 = state.waitingAnswer.imageBase64;

    const instructions =
      "これから数学・物理・化学などの問題が写った画像を送ります。\n\n" +
      "【してほしいこと】\n" +
      "1. まず画像の問題文を、日本語で読みやすく書き起こす。\n" +
      "2. その問題を、板書のように1行ずつ丁寧に解説する。\n" +
      "3. 最後に「答え：○○」の形式で答えを1行でまとめる。\n" +
      "4. そのあとで、生徒の答えが合っているか採点し、\n" +
      "   「正解」「惜しい」「不正解」のいずれかを伝える。\n" +
      "5. 間違っていた場合、どこでずれたかを簡潔に説明する。\n\n" +
      `【生徒の答え】\n${studentAnswer}\n\n` +
      "【禁止】\n" +
      "・Markdownの記号(#, *, **, ``` など)を使わない\n" +
      "・「計算機を使います」という表現を使わない\n";

    const resultText = await callOpenAIVision({
      imageBase64,
      instructions,
    });

    state.waitingAnswer = null;

    return replyText(event.replyToken, resultText);
  } catch (err) {
    console.error("handleImageWithStudentAnswer error:", err);
    state.waitingAnswer = null;
    return replyText(
      event.replyToken,
      "画像の解析中にちょっとエラーが出ちゃったみたい💦 もう一度送ってくれる？"
    );
  }
}

// ③ 生徒が「そのまま解説して」など → 答えなしで解説
async function handleImageExplainOnly(event, state) {
  try {
    let imageBase64 = state.waitingAnswer?.imageBase64;

    // 念のため、state に画像がなければこのテキストに対応する画像はないとみなす
    if (!imageBase64) {
      return replyText(
        event.replyToken,
        "さっきの画像が見当たらないみたい💦 もう一度画像を送ってくれる？"
      );
    }

    const instructions =
      "これから数学・物理・化学などの問題が写った画像を送ります。\n\n" +
      "【してほしいこと】\n" +
      "1. まず画像の問題文を、きれいに書き起こす。\n" +
      "2. その問題を、板書のように1行ずつ丁寧に解説する。\n" +
      "3. 最後に「答え：○○」の形式で答えを1行でまとめる。\n" +
      "4. 生徒の答えはないので、採点はせず、解説と答えだけを出す。\n\n" +
      "【禁止】\n" +
      "・Markdownの記号(#, *, **, ``` など)を使わない\n" +
      "・「計算機を使います」という表現を使わない\n";

    const resultText = await callOpenAIVision({
      imageBase64,
      instructions,
    });

    state.waitingAnswer = null;

    return replyText(event.replyToken, resultText);
  } catch (err) {
    console.error("handleImageExplainOnly error:", err);
    state.waitingAnswer = null;
    return replyText(
      event.replyToken,
      "画像の解説中にエラーが出ちゃったみたい💦 もう一度画像を送ってくれる？"
    );
  }
}

// =====================================================
// メニュー表示（シンプル版）
// =====================================================
async function replyMenu(replyToken) {
  const text =
    "🐻📘 くまお先生メニュー\n\n" +
    "・普通に質問 ⇒ そのまま聞いてね\n" +
    "・問題の写真 ⇒ カメラで送ってね（答えあり／なし両方OK）\n\n" +
    "「演習したい」などの機能は、これからどんどん増やしていく予定だよ🔥";

  return replyText(replyToken, text);
}

// =====================================================
// イベント処理本体
// =====================================================
async function handleEvent(event) {
  if (event.type !== "message") {
    // それ以外のイベントはとりあえず無視
    return;
  }

  const userId = event.source.userId;
  const state = getUserState(userId);

  // 画像メッセージ
  if (event.message.type === "image") {
    // 新しい画像が来たら、前の待ち状態はリセット
    state.waitingAnswer = null;
    return handleImageFirst(event, state);
  }

  // テキストメッセージ
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // メニュー
    if (text === "メニュー") {
      state.mode = "free";
      state.exercise = null;
      state.waitingAnswer = null;
      return replyMenu(event.replyToken);
    }

    // 画像の答え or 解説指示の可能性
    if (
      state.waitingAnswer &&
      state.waitingAnswer.kind === "image" &&
      state.waitingAnswer.status === "waiting_student_answer"
    ) {
      // 「解説」「そのまま」などが含まれていれば → 答えなしで解説
      if (
        text.includes("解説") ||
        text.includes("そのまま") ||
        text.includes("説明して")
      ) {
        return handleImageExplainOnly(event, state);
      }

      // それ以外は「生徒の答え」とみなして採点
      return handleImageWithStudentAnswer(event, state, text);
    }

    // 将来：演習モードなどをここに追加できる

    // 通常 FREE モード
    return handleFreeText(event, state);
  }

  // それ以外の message.type は今は無視
}

// =====================================================
// LINE Webhook エンドポイント
// =====================================================
app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events || [];

      // LINE 側にすぐ 200 を返す
      res.status(200).end();

      // 各イベントを非同期で処理
      await Promise.all(events.map((event) => handleEvent(event)));
    } catch (err) {
      console.error("Webhook error:", err);
      // ここで res は既に返しているので、何もしない
    }
  }
);

// ヘルスチェック用
app.get("/", (req, res) => {
  res.send("StudyEye くまお先生ボット running 🐻");
});

// -----------------------------------------------
// Railway / ローカル起動
// -----------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});

export default app;
