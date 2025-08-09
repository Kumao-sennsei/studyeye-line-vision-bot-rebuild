const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET       || process.env.LINE_CHANNEL_SECRET
};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!config.channelAccessToken || !config.channelSecret || !OPENAI_API_KEY) {
  console.error('❌ ENV不足: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY');
  process.exit(1);
}

const client = new line.Client(config);
const app = express();

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type === 'text') {
    const text = event.message.text;
    const reply = await kumaoReply(text);
    return client.replyMessage(event.replyToken, { type: 'text', text: reply });
  }
  if (event.message.type === 'image') {
    // 画像→説明（数式はテキスト表記・ハイライト記号）
    const content = await client.getMessageContent(event.message.id);
    const chunks = [];
    content.on('data', c => chunks.push(c));
    content.on('end', async () => {
      const b64 = Buffer.concat(chunks).toString('base64');
      const prompt = 'この画像の問題を日本語で解説。LaTeX禁止、√(), (a)/(b), x^nなどで。' +
        '重要=🔶 公式=🔷 答え=🟧 を文頭につけて、最後は【答え】一行。';
      const reply = await kumaoReply([{type:'text', text:prompt},{type:'image_url', image_url:{url:`data:image/png;base64,${b64}`}}]);
      await client.replyMessage(event.replyToken, { type: 'text', text: reply });
    });
  }
}

async function kumaoReply(userContent) {
  try {
    const messages = [
      { role: 'system', content:
        'あなたは「神仙人くまお先生」。やさしく面白く、絵文字はほどほど。' +
        '数式はLaTeX禁止で、√(), (a)/(b), x^n, ∫[a→b] f(x) dx, d/dx f(x)。' +
        '手順は番号付きで、最後は必ず一行で【答え】… を明記。' +
        '重要=🔶、公式=🔷、答え=🟧 を文頭に付けてハイライト。' },
      { role: 'user', content: userContent }
    ];
    const r = await axios.post('https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4o-mini', messages, temperature: 0.3 },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return sanitize(r.data.choices[0].message.content || '');
  } catch (e) {
    console.error('OpenAI error:', e.response?.data || e.message);
    return 'うまく計算できなかったみたい…もう一度送ってみてね(●´ω｀●)';
  }
}

// LaTeX 崩れ防止の整形
function sanitize(s) {
  if (!s) return s;
  let t = s.replace(/¥/g,'\\').replace(/\$\$?/g,'').replace(/\\\(|\\\)/g,'');
  t = t.replace(/\\[,\;\!\:]/g,' ')
       .replace(/\\left\s*/g,'(').replace(/\\right\s*/g,')')
       .replace(/\\(text|mathrm|operatorname)\s*\{([^{}]*)\}/g,'$2')
       .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,'($1)/($2)')
       .replace(/\\sqrt\{([^{}]+)\}/g,'√($1)')
       .replace(/\\cdot/g,'×').replace(/\\times/g,'×').replace(/\\div/g,'÷')
       .replace(/\\pm/g,'±').replace(/\\deg|\\degree/g,'°')
       .replace(/\\to/g,'→').replace(/->/g,'→')
       .replace(/\\alpha/g,'α').replace(/\\beta/g,'β').replace(/\\gamma/g,'γ')
       .replace(/\\delta/g,'δ').replace(/\\theta/g,'θ').replace(/\\lambda/g,'λ')
       .replace(/\\mu/g,'µ').replace(/\\pi/g,'π').replace(/\\sigma/g,'σ')
       .replace(/\\omega/g,'ω').replace(/\\Omega/g,'Ω').replace(/\\Delta/g,'Δ')
       .replace(/([A-Za-z0-9])\^2\b/g,'$1²').replace(/([A-Za-z0-9])\^3\b/g,'$1³')
       .replace(/\^\{([^{}]+)\}/g,'^$1')
       .replace(/\\[A-Za-z]+/g,'')
       .replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g,'$1 $2 $3')
       .replace(/\n?【答え】/g,'\n\n【答え】')
       .replace(/[ \t]+/g,' ').replace(/\s+\n/g,'\n').trim();
  return t;
}

app.get('/healthz', (_,res)=>res.status(200).json({ok:true}));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🐻 Kumao-sensei v6.1 (CJS) on ${PORT}`));
