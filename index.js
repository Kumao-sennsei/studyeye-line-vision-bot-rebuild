/**
 * eternal_final (hotfix v4) - Option ①: Text-only readability & clarity
 * - Env: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY (+ legacy LINE_* supported)
 * - Kumao-sensei tone; emoji moderate
 * - Step-by-step with numbered steps and explicit "何をしているか"
 * - Fractions as (num)/(den), sqrt(...) -> √(...), operator spacing, integral [a→b]
 * - Always ends with one-line 【答え】 simplified (数値化 or既約分数)
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

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
  "出力ルール:",
  "1) 何をしているかを日本語で明記しながら、番号つきで段階的に説明（1. 2. 3. ...）。",
  "2) 数式はLaTeX禁止。次の表記に統一:",
  "   - ルート: √(x)",
  "   - 二乗: x^2、三乗: x^3",
  "   - 分数: (分子)/(分母)",
  "   - 積分: ∫[a→b] f(x) dx",
  "   - 微分: d/dx f(x)",
  "   - 演算子の前後にはスペースを入れる (= + - × ÷ /)",
  "3) 最後に必ず一行で「【答え】...」を明記。可能なら数値化または既約分数で簡約。"
].join("\n");

// ---- Text filters ----
function sanitizeLatex(s) {
  if (!s) return s;
  s = s.replace(/\$\$?/g, "");
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  s = s.replace(/\^\{([^{}]+)\}/g, "^$1");
  s = s.replace(/\\cdot/g, "×");
  s = s.replace(/\\times/g, "×");
  s = s.replace(/\\int/g, "∫");
  return s;
}

function improveMathReadability(s) {
  if (!s) return s;
  let t = s;

  // sqrt(...) -> √(...)
  t = t.replace(/sqrt\(([^\(\)]+)\)/g, "√($1)");

  // Space around operators between tokens
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");

  // ∫ [aからb] or [a→b]
  t = t.replace(/∫\s*\[\s*([0-9\-\+\w]+)\s*(から|→)\s*([0-9\-\+\w]+)\s*\]/g, "∫[$1→$3]");

  // Ensure fractions have parentheses when simple tokens like a/b or (expr)/(expr)
  t = t.replace(/(\b[^\s\(\)]+)\s*\/\s*([^\s\(\)]+\b)/g, "($1)/($2)");

  // Collapse spaces
  t = t.replace(/[ \t]+/g, " ");
  // Improve answer visibility
  t = t.replace(/\n?【答え】/g, "\n\n【答え】");

  return t.trim();
}

async function ensureAnswerLine(bodyText) {
  if (!bodyText) return bodyText;
  if (bodyText.includes("【答え】")) return bodyText;
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '以下の解説の最終結論を日本語で一行にまとめ、「【答え】...」の形式で返してください。数式はLaTeX禁止で、√(), x^2, (a)/(b) を使う。できれば数値を簡約して。' },
          { role: 'user', content: bodyText }
        ],
        temperature: 0
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const line = resp.data.choices[0].message.content.trim();
    return bodyText + "\n\n" + improveMathReadability(line);
  } catch {
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

// ---- OpenAI ----
async function openaiChat(messages, model='gpt-4o', temperature=0.3) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages, temperature },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return resp.data.choices[0].message.content.trim();
}

async function handleText(userText) {
  try {
    const raw = await openaiChat([
      { role: 'system', content: STYLE_PROMPT },
      { role: 'user', content: userText }
    ]);
    const s1 = sanitizeLatex(raw);
    const s2 = improveMathReadability(s1);
    return await ensureAnswerLine(s2);
  } catch (e) {
    console.error("Text error:", e.response?.data || e.message);
    return "今日はちょっと調子が悪いみたい。また少し時間をおいて試してみてね！";
  }
}

async function handleImage(imageBuffer) {
  try {
    const base64 = imageBuffer.toString('base64');
    const raw = await openaiChat([
      { role: 'system', content: STYLE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'この画像の問題を解いて、何をしているかを日本語で明記しながら番号つきで解説してください。最後に【答え】を一行で明記。数式はLaTeX禁止（√(), (a)/(b), ∫[a→b] f(x) dx）。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
        ]
      }
    ]);
    const s1 = sanitizeLatex(raw);
    const s2 = improveMathReadability(s1);
    return await ensureAnswerLine(s2);
  } catch (e) {
    console.error("Image error:", e.response?.data || e.message);
    return "画像をうまく読めなかったよ。もう一度送ってみてね！";
  }
}

// ---- Webhook ----
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message') {
      const m = event.message;
      if (m.type === 'text') {
        const replyText = await handleText(m.text);
        await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
      } else if (m.type === 'image') {
        try {
          const content = await axios.get(
            `https://api-data.line.me/v2/bot/message/${m.id}/content`,
            { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }, responseType: 'arraybuffer' }
          );
          const replyText = await handleImage(Buffer.from(content.data));
          await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
        } catch (e) {
          console.error("Fetch image error:", e.response?.data || e.message);
          await replyToLine(event.replyToken, [{ type: 'text', text: "画像の取得に失敗しました。もう一度送ってみてね！" }]);
        }
      } else {
        await replyToLine(event.replyToken, [{ type: 'text', text: "今はテキストと画像メッセージに対応してるよ。" }]);
      }
    }
  }
  res.sendStatus(200);
});

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`🐻 Kumao-sensei bot (hotfix v4) listening on port ${PORT}`));