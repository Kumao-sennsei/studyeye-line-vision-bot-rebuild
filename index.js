const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

// 💾 ユーザー状態保存
const globalState = {};

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

// ✅ ヘルスチェック用
app.get('/healthz', (_, res) => res.status(200).json({ ok: true }));

// 🌐 Webhookエンドポイント
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ ok: true }); // ← 超重要！！！
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

// 🎯 イベントルーター
async function handleEvent(event) {
  if (event.type !== 'message') return;

  if (event.message.type === 'text') {
    return handleText(event);
  } else if (event.message.type === 'image') {
    return handleImage(event);
  } else {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'テキストと画像に対応してるよ〜📸✏️',
    });
  }
}

// 📄 テキスト処理
async function handleText(ev) {
  const text = ev.message.text.trim();
  const userId = ev.source.userId;

  const choiceMap = { あ: 0, か: 1, さ: 2, た: 3 };

  // 選択肢応答処理
  if (["あ", "か", "さ", "た"].includes(text)) {
    const state = globalState[userId];
    if (!state || !state.lastChoices) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: "今は選択肢の問題が出てないかも？\n「確認テスト: ○○」って送ってみてね🐻",
      });
    }

    const selected = choiceMap[text];
    const choice = state.lastChoices[selected];

    if (!choice) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: "その選択肢は今は無効だよ💦 もう一度送ってみてね！",
      });
    }

    if (choice.isCorrect) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `✨そのとおりっ！！ よくできました🌟\n\n次の「確認テスト: ○○」もやってみよう！`,
      });
    } else if (choice.isExtra) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `もっと詳しく知りたいんだね〜🐻\n\n${state.explanation || "解説がないよ💦"}`,
      });
    } else {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `うんうん、ここは間違えてもOKだよ🌱\n\n${state.explanation || "解説がないよ💦"}`,
      });
    }
  }

  // ✅ 確認テスト
  if (text.startsWith("確認テスト:")) {
    const question = text.replace("確認テスト:", "").trim();
    const correct = "内角の和は (n−2)×180° で求める";
    const wrong1  = "180÷n が内角の和";
    const wrong2  = "n×180 + 2 が内角の和";
    const extra   = "もっと詳しく教えて！";

    const choices = shuffle([
      { label: "あ", text: correct, isCorrect: true },
      { label: "か", text: wrong1 },
      { label: "さ", text: wrong2 },
    ]);
    choices.push({ label: "た", text: extra, isExtra: true });

    globalState[userId] = {
      lastChoices: choices,
      explanation: correct,
    };

    const reply = [
      `📝 ${question}`,
      ...choices.map(c => `${c.label}：${c.text}`),
      "↓ あ・か・さ・た で選んでね♪"
    ].join("\n");

    return client.replyMessage(ev.replyToken, { type: 'text', text: reply });
  }

  // 🤖 GPTで普通の質問に答える
  const system = buildSystemPrompt("text");
  const response = await openaiChat([
    { role: "system", content: system },
    { role: "user", content: buildGeneralPrompt(text) }
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// 📸 画像処理
async function handleImage(ev) {
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  const system = buildSystemPrompt("image");
  const prompt = [
    "画像の数学問題を読み取り、手順を説明し、最後に【答え】を一行で書いてください。",
    "数式は LINE 向けに (a)/(b), √(), x^n などで表現すること。"
  ].join("\n");

  const response = await openaiChat([
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    }
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// 🔧 OpenAI通信
async function openaiChat(messages) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o",
      temperature: 0.2,
      messages,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });
    return res.data.choices?.[0]?.message?.content || "解答が取得できませんでした";
  } catch (e) {
    console.error("OpenAI error:", e.response?.data || e.message);
    return "エラーが発生したよ💦";
  }
}

// 📜 ユーティリティ
function sanitize(s = "") {
  return s
    .replace(/¥/g, "\\")
    .replace(/\$\$?/g, "")
    .replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)")
    .replace(/\\sqrt{([^}]+)}/g, "√($1)")
    .replace(/\^\{([^}]+)\}/g, "^$1")
    .replace(/\\cdot/g, "×")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pm/g, "±")
    .replace(/\\[A-Za-z]+/g, "");
}

function withKumaoHighlights(s = "") {
  if (!/【答え】/.test(s)) {
    s += "\n\n（わからないことがあったらまた聞いてね🐻）";
  }
  return s;
}

function buildSystemPrompt(mode) {
  return [
    "あなたは『くまお先生』。優しく、正確に、記号はLINEで崩れない形式で。",
    mode === "image" ? "最後は必ず一行で【答え】を書いてください。" : ""
  ].join("\n");
}

function buildGeneralPrompt(text) {
  return `次の内容をやさしく説明してください：\n\n${text}`;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// 🚀 起動
const PORT = process.env.PORT || 8880;
// ヘルスチェック
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🧪 StudyEye LINE Bot Running on port ${PORT}`);
});

