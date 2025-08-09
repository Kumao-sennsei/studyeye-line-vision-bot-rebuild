/**
 * eternal_final_science_v6_1_textonly
 * - Text-first (LaTeX排除→読みやすい記号に変換)
 * - くまお先生口調、最後は必ず【答え】一行
 * - 依存を最小化（画像生成や重いネイティブ依存なし）
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ---- ENV ----
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET; // 署名検証は省略（必要なら追加可能）
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;
const PORT = process.env.PORT || 3000;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing env. Need CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY.");
  process.exit(1);
}

// ---- LINE reply ----
async function replyToLine(replyToken, messages){
  try{
    await axios.post('https://api.line.me/v2/bot/message/reply',
      { replyToken, messages },
      { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
    );
  }catch(e){
    console.error("LINE Reply Error:", e.response?.data || e.message);
  }
}

// ---- LaTeX → 読みやすい表記（理科記号OK）----
function sanitizeText(s){
  if(!s) return s;
  let t = s;

  // 1) Yen ↔ backslash
  t = t.replace(/¥/g, "\\"); // 日本語IME

  // 2) LaTeX系マーカー除去
  t = t.replace(/\$\$?/g, "");      // $...$ $$...$$
  t = t.replace(/\\\(|\\\)/g, "");  // \( \)

  // 3) スペーシング命令
  t = t.replace(/\\[,\;\!\:]/g, " ");

  // 4) \left \right → 括弧
  t = t.replace(/\\left\s*/g, "(").replace(/\\right\s*/g, ")");

  // 5) テキスト系 \text{} \mathrm{} \operatorname{}
  t = t.replace(/\\(text|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$2");

  // 6) 分数・根号・演算子
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  t = t.replace(/\\cdot/g, "×").replace(/\\times/g, "×").replace(/\\div/g, "÷");
  t = t.replace(/\\pm/g, "±").replace(/\\deg/g, "°").replace(/\\degree/g, "°");
  t = t.replace(/\\to/g, "→").replace(/->/g, "→");

  // 7) ギリシャ文字など（主要）
  const map = {
    '\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\theta':'θ','\\lambda':'λ',
    '\\mu':'µ','\\pi':'π','\\sigma':'σ','\\omega':'ω','\\Omega':'Ω','\\Delta':'Δ'
  };
  for(const k in map){ t = t.replace(new RegExp(k,'g'), map[k]); }

  // 8) べき（² ³）、その他の指数は ^n のまま
  t = t.replace(/([A-Za-z0-9])\^2\b/g, "$1²");
  t = t.replace(/([A-Za-z0-9])\^3\b/g, "$1³");
  t = t.replace(/\^\{([^{}]+)\}/g, "^$1");

  // 9) 残コマンドをざっくり除去（\textbfなど）
  t = t.replace(/\\[A-Za-z]+/g, "");

  // 10) 演算子の前後スペース
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");

  // 11) 【答え】の前に空行
  t = t.replace(/\n?【答え】/g, "\n\n【答え】");

  // 12) 空白整理
  t = t.replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
  return t;
}

const SYSTEM = [
  "あなたは『くまお先生』です。やさしく面白く、絵文字はほどほど。",
  "LINEで崩れない表記を使う（√(), (a)/(b), x^n, ∫[a→b] f(x) dx, d/dx f(x)、単位やギリシャ文字はUnicode）。",
  "手順は番号付きで、最後は必ず一行で【答え】を明記。",
  "LaTeXは本文に出さない。必要なときは式を簡易表記で説明する。"
].join("\n");

async function callOpenAI(messages){
  const r = await axios.post('https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o', messages, temperature: 0.3 },
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  return r.data.choices[0].message.content;
}

// ---- Webhook ----
app.post('/webhook', async (req,res)=>{
  const events = req.body.events || [];
  for(const ev of events){
    if(ev.type === 'message'){
      const m = ev.message;
      try{
        if(m.type === 'text'){
          const content = await callOpenAI([
            { role:'system', content: SYSTEM },
            { role:'user', content: m.text }
          ]);
          const safe = sanitizeText(content);
          await replyToLine(ev.replyToken, [{ type:'text', text: safe }]);
        }else if(m.type === 'image'){
          // 画像→説明（数式は簡易表記）
          const img = await axios.get(`https://api-data.line.me/v2/bot/message/${m.id}/content`, {
            headers:{ Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }, responseType:'arraybuffer'
          });
          const base64 = Buffer.from(img.data).toString('base64');
          const content = await callOpenAI([
            { role:'system', content: SYSTEM },
            { role:'user', content: [
              { type:'text', text:'この画像の問題を解説して、最後に【答え】を一行で明記。数式はLaTeX禁止、読みやすい表記で。' },
              { type:'image_url', image_url:{ url:`data:image/png;base64,${base64}` } }
            ]}
          ]);
          const safe = sanitizeText(content);
          await replyToLine(ev.replyToken, [{ type:'text', text: safe }]);
        }else{
          await replyToLine(ev.replyToken, [{ type:'text', text:'今はテキストと画像に対応してるよ。' }]);
        }
      }catch(e){
        console.error("Flow error:", e.response?.data || e.message);
        await replyToLine(ev.replyToken, [{ type:'text', text:'処理に失敗しちゃった。もう一度送ってみてね！' }]);
      }
    }
  }
  res.sendStatus(200);
});

app.get('/healthz', (req,res)=>res.status(200).json({ ok:true, uptime:process.uptime() }));

app.listen(PORT, ()=>console.log(`🐻 Kumao-sensei bot (science v6.1 textonly) listening on port ${PORT}`));
