
/**
 * eternal_final_science_v6
 * - Text-first: LINEで崩れない数学/理科表記（LaTeX禁止・置換）
 * - 必要時のみ黒板画像（<LATEX> ... </LATEX> を画像化）
 * - くまお先生口調、最後は必ず【答え】一行
 * - Env: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY (+ PUBLIC_BASE_URL 任意)
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
require('dotenv').config();

// MathJax (SVG) for image rendering
const { mathjax } = require('mathjax-full/js/mathjax.js');
const { TeX } = require('mathjax-full/js/input/tex.js');
const { SVG } = require('mathjax-full/js/output/svg.js');
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({ packages: ['base','ams','noerrors','noundefined'] });
const svg = new SVG({ fontCache: 'none', scale: 1.2 });
const html = mathjax.document('', { InputJax: tex, OutputJax: svg });

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ---- Env ----
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

// ---- Helpers ----
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

// ---- Text sanitization (LaTeX -> Unicode/ASCII-friendly) ----
function sanitizeText(s) {
  if (!s) return s;
  let t = s;

  // Remove LaTeX dollar and code fences
  t = t.replace(/\$\$?/g, "");

  // Normalize Yen/backslash issues
  t = t.replace(/¥/g, "\\"); // JP keyboards sometimes show Yen

  // Replace LaTeX commands with readable forms
  t = t.replace(/\\left\s*/g, "(").replace(/\\right\s*/g, ")");
  t = t.replace(/\\times/g, "×").replace(/\\cdot/g, "×");
  t = t.replace(/\\div/g, "÷");
  t = t.replace(/\\pm/g, "±");
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  t = t.replace(/\\overline\{([^{}]+)\}/g, "‾$1");
  t = t.replace(/\\degree/g, "°");

  // Greek letters & physics symbols (common subset)
  const greekMap = {
    '\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\theta':'θ','\\lambda':'λ','\\mu':'µ','\\pi':'π','\\sigma':'σ','\\omega':'ω','\\Omega':'Ω','\\Delta':'Δ'
  };
  for (const k in greekMap) {
    t = t.replace(new RegExp(k, 'g'), greekMap[k]);
  }

  // Units / arrows
  t = t.replace(/\\to/g, "→").replace(/->/g, "→");

  // Superscripts 2 and 3 (simple cases a^2 -> a², a^3 -> a³)
  t = t.replace(/([A-Za-z0-9])\^2\b/g, "$1²");
  t = t.replace(/([A-Za-z0-9])\^3\b/g, "$1³");

  // Ensure operator spacing
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");

  // Improve answer visibility
  t = t.replace(/\n?【答え】/g, "\n\n【答え】");

  // Collapse spaces
  t = t.replace(/[ \t]+/g, " ").trim();

  return t;
}

// Extract <LATEX> for image rendering
function extractLatexBlock(s) {
  if (!s) return null;
  const m = s.match(/<LATEX>\s*([\s\S]*?)\s*<\/LATEX>/i);
  if (m) return m[1].trim();
  return null;
}

// Render LaTeX to chalkboard PNG
async function renderLatexToChalkboardPng(latex, outPath) {
  const node = html.convert(latex, { display: true });
  let svgString = adaptor.outerHTML(node);
  svgString = svgString.replace(/fill="[^"]*"/g, 'fill="#FFFFFF"')
                       .replace(/stroke="[^"]*"/g, 'stroke="#FFFFFF"');

  // Determine size
  const vb = svgString.match(/viewBox="([0-9\.\s\-]+)"/);
  let width = 1200, height = 480;
  if (vb) {
    const [x,y,vbw,vbh] = vb[1].split(/\s+/).map(Number);
    const scale = 1.8;
    width = Math.max(900, Math.floor(vbw*scale)+200);
    height = Math.max(360, Math.floor(vbh*scale)+200);
    svgString = svgString.replace(/<svg[^>]*>/, (tag) => {
      return tag.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, '')
                .replace(/>/, ` width="${Math.floor(vbw*scale)}" height="${Math.floor(vbh*scale)}">`);
    });
  }

  const bg = { create: { width, height, channels: 3, background: { r:18,g:48,b:40 } } };
  const svgBuffer = Buffer.from(svgString);
  await sharp(bg)
    .composite([{ input: svgBuffer, top: 100, left: 100 }])
    .png()
    .toFile(outPath);
  return outPath;
}

// Build reply (text + optional image)
function buildReply(text, imageUrl) {
  const msgs = [{ type: 'text', text }];
  if (imageUrl) {
    msgs.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  return msgs;
}

// Prompts
const SYSTEM_PROMPT = [
  "あなたは『くまお先生』です。絵文字はほどほど、やさしく面白くわかりやすく。",
  "テキストではLaTeXを使わず、√(), (a)/(b), x^n, ∫[a→b] f(x) dx, d/dx f(x) などの読みやすい表記を使ってください。",
  "理科の記号は Unicode を使い、単位やギリシャ文字（α, β, θ, λ, µ, Ω, Δ など）を正しく表示。",
  "手順は番号付きで、最後に必ず一行で「【答え】...」。",
  "もし複雑な式がある場合は、最後に <LATEX> ... </LATEX> で数式だけを1ブロック示してください（この部分だけ画像化します）。"
].join("\n");

async function openaiChat(messages, model='gpt-4o', temperature=0.3) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model, messages, temperature },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return resp.data.choices[0].message.content;
}

async function handleContent(req, replyToken, content) {
  const latex = extractLatexBlock(content);
  const textOnly = content.replace(/<LATEX>[\s\S]*?<\/LATEX>/i, "").trim();
  const safeText = sanitizeText(textOnly);

  let imageUrl = null;
  if (latex) {
    try {
      const id = uuidv4();
      const outPath = path.join(__dirname, 'public', 'boards', `${id}.png`);
      await renderLatexToChalkboardPng(latex, outPath);
      const baseUrl = buildPublicBaseUrl(req);
      imageUrl = `${baseUrl}/public/boards/${id}.png`;
    } catch (e) {
      console.error("Render error:", e.message);
    }
  }

  const messages = buildReply(safeText, imageUrl);
  await replyToLine(replyToken, messages);
}

// Handlers
async function handleText(req, replyToken, userText) {
  try {
    const content = await openaiChat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText }
    ]);
    await handleContent(req, replyToken, content);
  } catch (e) {
    console.error("Text error:", e.response?.data || e.message);
    await replyToLine(replyToken, [{ type: 'text', text: "ちょっと混んでるみたい。また少ししてから試してね！" }]);
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
      { role: 'user', content: [
        { type:'text', text:'この画像の問題を解説し、必要に応じて数式を <LATEX>..</LATEX> で示し、最後に【答え】を一行で明記。' },
        { type:'image_url', image_url:{ url:`data:image/png;base64,${base64}` } }
      ]}
    ]);
    await handleContent(req, replyToken, content);
  } catch (e) {
    console.error("Image error:", e.response?.data || e.message);
    await replyToLine(replyToken, [{ type: 'text', text: "画像をうまく読めなかったよ。もう一度送ってみてね！" }]);
  }
}

// Webhook
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === 'message') {
      const m = ev.message;
      if (m.type === 'text') await handleText(req, ev.replyToken, m.text);
      else if (m.type === 'image') await handleImage(req, ev.replyToken, m.id);
      else await replyToLine(ev.replyToken, [{ type:'text', text:'今はテキストと画像に対応してるよ。' }]);
    }
  }
  res.sendStatus(200);
});

app.get('/healthz', (req, res) => res.status(200).json({ ok:true, uptime:process.uptime() }));

app.listen(PORT, () => console.log(`🐻 Kumao-sensei bot (science v6) listening on port ${PORT}`));
