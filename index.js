/**
 * eternal_final (hotfix v2)
 * - Env names: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY (primary)
 *   also supports LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / OPENAI_KEY
 * - Adds style prompt for Kumao-sensei (emoji moderate, friendly)
 * - Ensures final explicit answer block: 【答え】... （fallback one-line summary via extra call）
 * - Sanitizes LaTeX-like math to plain text (sqrt(), x^2, integral notation, etc.)
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ---- Environment variables (user-first names) ----
const CHANNEL_ACCESS_TOKEN =
  process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;

const CHANNEL_SECRET =
  process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

const PORT = process.env.PORT || 3000;

// Verify env vars
if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing environment variables. Need CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY.");
  process.exit(1);
}

// ---- Style prompt (Kumao-sensei) ----
const STYLE_PROMPT = [
  "あなたは『くまお先生』です。",
  "口調: やさしく・面白く・わかりやすく。絵文字はほどほど。",
  "厳守:",
  "1) 途中の式や考え方は丁寧に。",
  "2) 最後に必ず「【答え】...」の形で一行で結論を明記。",
  "3) 数式はLaTeX禁止。次の表記で書く:",
  "   - ルート: sqrt(x) / sqrt(a+b)",
  "   - 二乗: x^2, 三乗: x^3, n乗: x^n",
  "   - 分数: a/b",
  "   - 積分: ∫ f(x) dx, または integral of f(x) dx from a to b",
  "   - 微分: d/dx f(x)",
  "   - かけ算: ×, 割り算: ÷ または /",
  "4) 記号の前後は半角スペースで読みやすく。"
].join("\n");

// ---- Helpers ----
function sanitizeMath(plain) {
  if (!plain) return plain;
  let s = plain;

  // Remove LaTeX inline markers
  s = s.replace(/\$\$?/g, "");

  // \sqrt{...} -> sqrt(...)
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");

  // \frac{a}{b} -> a/b
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2");

  // ^{2} -> ^2  , ^{n} -> ^n
  s = s.replace(/\^\{([^{}]+)\}/g, "^$1");

  // \cdot -> ×
  s = s.replace(/\\cdot/g, "×");

  // \times -> ×
  s = s.replace(/\\times/g, "×");

  // \int -> ∫
  s = s.replace(/\\int/g, "∫");

  // \rightarrow, \to -> ->
  s = s.replace(/\\(rightarrow|to)/g, "->");

  // Fix multiple spaces
  s = s.replace(/[ \t]+/g, " ");

  return s.trim();
}

async function ensureAnswerBlock(bodyText) {
  if (!bodyText) return bodyText;
  if (bodyText.includes("【答え】")) {
    return bodyText;
  }
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '次の文章の要点（最終的な答え）を日本語で一行に短くまとめ、「【答え】...」の形式で返してください。数式はLaTeX禁止。' },
          { role: 'user', content: bodyText }
        ],
        temperature: 0
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const oneLine = resp.data.choices[0].message.content.trim();
    return bodyText + "\n\n" + sanitizeMath(oneLine);
  } catch (err) {
    // 失敗しても本文だけ返す
    return bodyText + "\n\n【答え】（本文の最後の結論を1行で要約）";
  }
}

// ---- LINE reply ----
async function replyToLine(replyToken, messages) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken, messages },
      { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error("LINE Reply Error:", err.response?.data || err.message);
  }
}

// ---- OpenAI calls ----
async function openaiChat(messages, model='gpt-4o', temperature=0.4) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages, temperature },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return resp.data.choices[0].message.content.trim();
}

async function getTextResponse(userText) {
  try {
    const raw = await openaiChat([
      { role: 'system', content: STYLE_PROMPT },
      { role: 'user', content: userText }
    ], 'gpt-4o', 0.4);
    const sanitized = sanitizeMath(raw);
    return await ensureAnswerBlock(sanitized);
  } catch (err) {
    console.error("OpenAI Text Error:", err.response?.data || err.message);
    return "今日はちょっと調子が悪いみたい。また試してみてね！";
  }
}

async function getImageAnalysis(imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const raw = await openaiChat([
      { role: 'system', content: STYLE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'この画像を解析して、やさしく面白くわかりやすく解説してください。最後に【答え】を一行で明記。数式はLaTeX禁止で。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }
    ], 'gpt-4o', 0.4);
    const sanitized = sanitizeMath(raw);
    return await ensureAnswerBlock(sanitized);
  } catch (err) {
    console.error("OpenAI Image Error:", err.response?.data || err.message);
    return "画像を読み込めなかったよ。もう一度送ってみてね！";
  }
}

// ---- Webhook ----
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message') {
      const message = event.message;
      if (message.type === 'text') {
        const replyText = await getTextResponse(message.text);
        await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
      } else if (message.type === 'image') {
        try {
          const contentResp = await axios.get(
            `https://api-data.line.me/v2/bot/message/${message.id}/content`,
            {
              headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
              responseType: 'arraybuffer'
            }
          );
          const replyText = await getImageAnalysis(Buffer.from(contentResp.data));
          await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
        } catch (err) {
          console.error("Image Fetch Error:", err.response?.data || err.message);
          await replyToLine(event.replyToken, [{ type: 'text', text: "画像を取得できなかったよ。もう一度送ってみてね！" }]);
        }
      } else {
        await replyToLine(event.replyToken, [{ type: 'text', text: "今はテキストと画像だけに対応してるよ。" }]);
      }
    }
  }
  res.sendStatus(200);
});

// ---- Health check ----
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`🐻 Kumao-sensei bot (hotfix v2) listening on port ${PORT}`);
});