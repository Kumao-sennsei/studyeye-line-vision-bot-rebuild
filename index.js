/**
 * eternal_final (hotfix v3) - Readability upgrade
 * - Env names: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY (primary)
 *   + legacy LINE_CHANNEL_* supported
 * - Kumao-sensei tone (gentle, fun, clear; emoji moderate)
 * - Always ends with 【答え】... one-line
 * - Math readability: LaTeX stripped, sqrt(...) -> √(...), operator spacing
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ---- Env vars (user naming first) ----
const CHANNEL_ACCESS_TOKEN =
  process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;

const CHANNEL_SECRET =
  process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

const PORT = process.env.PORT || 3000;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing environment variables. Need CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY.");
  process.exit(1);
}

// ---- Style prompt ----
const STYLE_PROMPT = [
  "あなたは『くまお先生』です。",
  "口調: やさしく・面白く・わかりやすく。絵文字はほどほど。",
  "厳守:",
  "1) 説明は段階的に。",
  "2) 数式はLaTeX禁止。√, x^2, a/b, ∫ f(x) dx を使う。",
  "3) 最後に必ず「【答え】...」を1行で明記。"
].join("\n");

// ---- Readability helpers ----
function sanitizeLatex(text) {
  if (!text) return text;
  let s = text;
  s = s.replace(/\$\$?/g, "");
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2");
  s = s.replace(/\^\{([^{}]+)\}/g, "^$1");
  s = s.replace(/\\cdot/g, "×");
  s = s.replace(/\\times/g, "×");
  s = s.replace(/\\int/g, "∫");
  s = s.replace(/\\(rightarrow|to)/g, "->");
  return s;
}

function improveMathReadability(text) {
  if (!text) return text;
  let s = text;

  // sqrt(...) -> √(...)
  s = s.replace(/sqrt\(([^\(\)]+)\)/g, "√($1)");

  // Add spaces around operators when it's likely an infix op (left side is number/letter/close paren)
  // =, +, -, ×, ÷, /
  s = s.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");

  // Collapse multiple spaces
  s = s.replace(/[ \t]+/g, " ");

  // Ensure 【答え】 block has a blank line before it (for visibility)
  s = s.replace(/\n?【答え】/g, "\n\n【答え】");

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
          { role: 'system', content: '次の文章の最終結論を日本語で一行にまとめ、「【答え】...」の形式で返してください。数式はLaTeX禁止で、√, x^2, a/b を使う。' },
          { role: 'user', content: bodyText }
        ],
        temperature: 0
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const oneLine = resp.data.choices[0].message.content.trim();
    return bodyText + "\n\n" + improveMathReadability(oneLine);
  } catch (err) {
    return bodyText + "\n\n【答え】（本文の結論を一行で要約）";
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

// ---- OpenAI call ----
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
    ]);
    const cleaned = sanitizeLatex(raw);
    const readable = improveMathReadability(cleaned);
    return await ensureAnswerBlock(readable);
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
          { type: 'text', text: 'この画像を解析して、やさしく面白くわかりやすく解説してください。最後に【答え】を一行で明記。数式はLaTeX禁止。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }
    ]);
    const cleaned = sanitizeLatex(raw);
    const readable = improveMathReadability(cleaned);
    return await ensureAnswerBlock(readable);
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

// ---- Health ----
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`🐻 Kumao-sensei bot (hotfix v3) listening on port ${PORT}`);
});