/**
 * eternal_final_hybrid_v5
 * - Text explanation (Kumao-sensei tone, emoji moderate, LaTeX-free text)
 * - Math image (dark chalkboard style) generated from a LaTeX block
 * - Replies with: text + image (when complex math exists)
 * - Env vars (user naming): CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY
 *   Optional: PUBLIC_BASE_URL (e.g., https://your-app.up.railway.app)
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
require('dotenv').config();

// MathJax (SVG) setup
const mj = require('mathjax-full/js/mathjax.js').mathjax;
const TeX = require('mathjax-full/js/input/tex.js').TeX;
const SVG = require('mathjax-full/js/output/svg.js').SVG;
const liteAdaptor = require('mathjax-full/js/adaptors/liteAdaptor.js').liteAdaptor;
const RegisterHTMLHandler = require('mathjax-full/js/handlers/html.js').RegisterHTMLHandler;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({
  packages: ['base', 'ams', 'noerrors', 'noundefined'],
});
const svg = new SVG({
  fontCache: 'none',
  scale: 1.2,
});
const html = mj.document('', { InputJax: tex, OutputJax: svg });

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

const CHANNEL_ACCESS_TOKEN =
  process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET =
  process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL_ENV = process.env.PUBLIC_BASE_URL;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing environment variables. Need CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY.");
  process.exit(1);
}

// ----- Helpers -----
function buildPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL_ENV) return PUBLIC_BASE_URL_ENV.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

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

// Sanitize for LaTeX-free text (for readability in LINE)
function sanitizeTextMath(s) {
  if (!s) return s;
  let t = s;
  t = t.replace(/\$\$?/g, "");
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  t = t.replace(/\^\{([^{}]+)\}/g, "^$1");
  t = t.replace(/\\cdot/g, "×").replace(/\\times/g, "×");
  t = t.replace(/\\int/g, "∫");
  // Space around operators
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");
  // Ensure 【答え】 is visible
  t = t.replace(/\n?【答え】/g, "\n\n【答え】");
  return t.trim();
}

// OpenAI helpers
async function openaiChat(messages, model='gpt-4o', temperature=0.3) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages, temperature },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return resp.data.choices[0].message.content;
}

// Parse <LATEX> ... </LATEX>
function extractLatexBlock(s) {
  if (!s) return null;
  const m = s.match(/<LATEX>\s*([\s\S]*?)\s*<\/LATEX>/i);
  if (m) return m[1].trim();
  // fallback: $$...$$
  const m2 = s.match(/\$\$([\s\S]*?)\$\$/);
  if (m2) return m2[1].trim();
  return null;
}

// Render LaTeX (MathJax SVG) onto chalkboard PNG
async function renderLatexToChalkboardPng(latex, outPath) {
  // Typeset to SVG
  const node = html.convert(latex, { display: true });
  let svgString = adaptor.outerHTML(node);
  // Force white stroke/fill
  svgString = svgString.replace(/fill="[^"]*"/g, 'fill="#FFFFFF"')
                       .replace(/stroke="[^"]*"/g, 'stroke="#FFFFFF"');

  // Get viewBox size
  const vb = svgString.match(/viewBox="([0-9\.\s\-]+)"/);
  let width = 1200, height = 400;
  if (vb) {
    const parts = vb[1].split(/\s+/).map(Number);
    const vbw = parts[2], vbh = parts[3];
    const scale = 2.0; // upscale for crispness
    width = Math.max(800, Math.floor(vbw * scale + 200));
    height = Math.max(300, Math.floor(vbh * scale + 200));
    // Scale svg
    svgString = svgString.replace(/<svg[^>]*>/, (tag) => {
      return tag.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '')
                .replace(/>/, ` width="${Math.floor(vbw*scale)}" height="${Math.floor(vbh*scale)}">`);
    });
  }

  // Create chalkboard background (dark green)
  const bg = {
    create: {
      width, height, channels: 3, background: { r: 18, g: 48, b: 40 } // dark board
    }
  };

  // Compose SVG centered
  const svgBuffer = Buffer.from(svgString);
  const img = await sharp(bg)
    .composite([{ input: svgBuffer, top: Math.floor((height -  Math.min(height-80, height-200)) / 2), left: 100 }])
    .png()
    .toFile(outPath);

  return outPath;
}

// Build messages: text + image (if any)
function buildReplyMessages(text, imageUrl) {
  const msgs = [{ type: 'text', text }];
  if (imageUrl) {
    msgs.push({
      type: 'image',
      originalContentUrl: imageUrl,
      previewImageUrl: imageUrl
    });
  }
  return msgs;
}

// Prompts
const SYSTEM_PROMPT = [
  "あなたは『くまお先生』です。絵文字はほどほど。",
  "やさしく・面白く・わかりやすく、スマホで読みやすい文で解説。",
  "必ず番号つきで「何をしているか」を明記（1. 2. 3. ...）。",
  "テキストではLaTeX禁止（sqrt→√、a/b→(a)/(b)、積分は ∫[a→b] f(x) dx）。",
  "最後に必ず一行で「【答え】...」。",
  "そして、数式画像用に LaTeX を <LATEX> と </LATEX> で囲んで最後に添えてください（画像生成に使います）。"
].join("\n");

async function handleText(req, replyToken, userText) {
  try {
    const content = await openaiChat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText }
    ]);

    const latex = extractLatexBlock(content);
    const text = sanitizeTextMath(content.replace(/<LATEX>[\s\S]*?<\/LATEX>/i, "").trim());

    let imageUrl = null;
    if (latex) {
      const baseUrl = buildPublicBaseUrl(req);
      const id = uuidv4();
      const outPath = path.join(__dirname, 'public', 'boards', `${id}.png`);
      try {
        await renderLatexToChalkboardPng(latex, outPath);
        imageUrl = `${baseUrl}/public/boards/${id}.png`;
      } catch (e) {
        console.error("Render error:", e.message);
      }
    }

    const messages = buildReplyMessages(text, imageUrl);
    await replyToLine(replyToken, messages);
  } catch (e) {
    console.error("Text flow error:", e.response?.data || e.message);
    await replyToLine(replyToken, [{ type: 'text', text: "今日はちょっと調子が悪いみたい。また少し時間をおいて試してみてね！" }]);
  }
}

async function handleImage(req, replyToken, messageId) {
  try {
    const imgResp = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }, responseType: 'arraybuffer' }
    );
    const base64 = Buffer.from(imgResp.data).toString('base64');

    const content = await openaiChat([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'この画像を解説して、必要なら数式を使って解き、最後に【答え】を明記。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
        ]
      }
    ]);

    const latex = extractLatexBlock(content);
    const text = sanitizeTextMath(content.replace(/<LATEX>[\s\S]*?<\/LATEX>/i, "").trim());

    let imageUrl = null;
    if (latex) {
      const baseUrl = buildPublicBaseUrl(req);
      const id = uuidv4();
      const outPath = path.join(__dirname, 'public', 'boards', `${id}.png`);
      try {
        await renderLatexToChalkboardPng(latex, outPath);
        imageUrl = `${baseUrl}/public/boards/${id}.png`;
      } catch (e) {
        console.error("Render error:", e.message);
      }
    }

    const messages = buildReplyMessages(text, imageUrl);
    await replyToLine(replyToken, messages);
  } catch (e) {
    console.error("Image flow error:", e.response?.data || e.message);
    await replyToLine(replyToken, [{ type: 'text', text: "画像をうまく読めなかったよ。もう一度送ってみてね！" }]);
  }
}

// Webhook
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === 'message') {
      const m = ev.message;
      if (m.type === 'text') {
        await handleText(req, ev.replyToken, m.text);
      } else if (m.type === 'image') {
        await handleImage(req, ev.replyToken, m.id);
      } else {
        await replyToLine(ev.replyToken, [{ type: 'text', text: "今はテキストと画像に対応してるよ。" }]);
      }
    }
  }
  res.sendStatus(200);
});

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`🐻 Kumao-sensei bot (hybrid v5) listening on port ${PORT}`);
});