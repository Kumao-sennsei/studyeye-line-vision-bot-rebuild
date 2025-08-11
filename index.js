const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');

/** ====== ENV ====== */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET       || process.env.LINE_CHANNEL_SECRET
};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MATH_CAS_URL   = process.env.MATH_CAS_URL || ""; // 任意: SymPy等のCAS API

if (!config.channelAccessToken || !config.channelSecret || !OPENAI_API_KEY) {
  console.error('❌ ENV不足: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY');
  process.exit(1);
}

/** ====== App ====== */
const client = new line.Client(config);
const app = express();
app.get('/healthz', (_,res)=>res.status(200).json({ ok:true, cas: !!MATH_CAS_URL }));
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

/** ====== Event Router ====== */
async function handleEvent(event){
  if (event.type !== 'message') return;
  const m = event.message;
  if (m.type === 'text')  return handleText(event);
  if (m.type === 'image') return handleImage(event);
  return client.replyMessage(event.replyToken, { type:'text', text: '今はテキストと画像に対応してるよ(●´ω｀●)' });
}

/** ====== Flow: Text（答えは付けない） ====== */
async function handleText(ev){
  const userText = ev.message.text || "";
  const mathy = isMathy(userText);
  const system = buildSystemPrompt({ answerMode:'text' });

  if (mathy) {
    // 数学：二重計算＋検算（モデル）＋必要ならCAS裏取り
    const prompt = buildMathSolvePrompt(userText);
    const first  = await openaiChat({ model:'gpt-4o', messages:[
      { role:'system', content: system },
      { role:'user',   content: prompt }
    ]});
    const verify = await openaiChat({ model:'gpt-4o', temperature:0.1, messages:[
      { role:'system', content: system },
      { role:'user',   content: "今の解を別の観点で短く検算し、一致しなければ修正して整合させて。" }
    ]});
    let merged = sanitize(`${first}\n\n🔶 検算メモ\n${verify}`);
    merged = merged.replace(/\n?【答え】.*/gs, "").trim(); // テキスト会話では答え行を消す

    if (MATH_CAS_URL && /∫|integral|dx|dy/.test(userText)) {
      try {
        const cas = await casCompute({ task:'auto', input:userText });
        if (cas && cas.result) {
          merged += `\n\n🔷 CAS検算: ${cas.resultSummary || cas.result}`;
        }
      } catch(e) { console.error('CAS error:', e.message); }
    }

    const out = withKumaoHighlights(merged);
    return client.replyMessage(ev.replyToken, { type:'text', text: out });
  }

  // 一般会話
  const general = await openaiChat({ model:'gpt-4o-mini', messages:[
    { role:'system', content: system },
    { role:'user',   content: buildGeneralPrompt(userText) }
  ]});
  const out = withKumaoHighlights(sanitize(general).replace(/\n?【答え】.*/gs,"").trim());
  return client.replyMessage(ev.replyToken, { type:'text', text: out });
}

/** ====== Flow: Image（最後に必ず【答え】） ====== */
async function handleImage(ev){
  try {
    const stream = await client.getMessageContent(ev.message.id);
    const bufs = [];
    await new Promise((resolve, reject)=>{
      stream.on('data', c => bufs.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const b64 = Buffer.concat(bufs).toString('base64');

    const system = buildSystemPrompt({ answerMode:'image' });
    const prompt = [
      "画像の問題を読み取り、手順を番号付きで丁寧に解説してください。",
      "数学は通常計算→別観点で検算→一致しない場合は修正し、整合した最終結果を提示。",
      "最後は必ず一行で【答え】... を明記（単位があれば単位も）。",
      "最終出力はLINEで崩れない記号表記（√(), (a)/(b), x^n など）。"
    ].join("\n");

    let content = await openaiChat({
      model:'gpt-4o', temperature:0.2,
      messages:[
        { role:'system', content: system },
        { role:'user', content: [
          { type:'text', text: prompt },
          { type:'image_url', image_url:{ url:`data:image/png;base64,${b64}` } }
        ]}
      ]
    });
    let out = sanitize(content);

    // 任意：CAS検算
    if (MATH_CAS_URL) {
      try {
        const cas = await casCompute({ task:'auto', input:'(image)' });
        if (cas && cas.result) out += `\n\n🔷 CAS検算: ${cas.resultSummary || cas.result}`;
      } catch(e) {}
    }

    // 【答え】が無ければ強制付与
    if (!/【答え】/.test(out)) {
      const fix = await openaiChat({
        model:'gpt-4o',
        messages:[
          { role:'system', content: system },
          { role:'user',   content: "上記の結論から最終値を抽出し、一行で【答え】... を必ず付けて簡潔にまとめて。" }
        ]
      });
      out = sanitize(fix);
    }
    return client.replyMessage(ev.replyToken, { type:'text', text: withKumaoHighlights(out) });
  } catch (e) {
    console.error('image flow error:', e.message);
    return client.replyMessage(ev.replyToken, { type:'text', text:'画像を読み取れなかったよ…もう一度送ってみてね(；ω；)' });
  }
}

/** ====== Prompts / Utils ====== */
function isMathy(s=''){
  return /∫|√|\^|\/|=|≤|≥|Σ|Π|sin|cos|tan|log|ln|微分|積分|方程式|平方|二次|三角関数|ベクトル|行列|dy\/dx|d\/dx|dx|dy/.test(s);
}
function buildSystemPrompt({answerMode}){
  return [
    "あなたは『神仙人くまお先生』。やさしく面白く、絵文字はほどほど。日本語で解説。",
    "数式は本文ではLaTeXでもよいが、最終の返答はLINEで崩れない記号表記に整形（√(), (a)/(b), x^n, ∫[a→b] f(x) dx）。",
    "手順は番号付きで、何をしているかを短文で説明。式はできるだけ短く分割。",
    (answerMode==='image' ? "最後は必ず一行で「【答え】...」。" : "会話時は【答え】を付けない。")
  ].join("\n");
}
function buildMathSolvePrompt(userText){
  return [
    "次の問題を解いてください。通常の方針で計算し、別の観点で必ず検算してください。",
    "一致しない場合は手順を見直し、整合した最終結果に。",
    "最後はLINEで崩れない記号表記（√(), (a)/(b), x^n）。",
    "", `【問題】\n${userText}`
  ].join("\n");
}
function buildGeneralPrompt(userText){
  return [
    "以下を、くまお先生の優しい会話口調でわかりやすく説明してください。",
    "数式が出ても読みやすい記号表記（√(), (a)/(b), x^n）。",
    "最後に【答え】は付けない。",
    "", `【話題】\n${userText}`
  ].join("\n");
}

async function openaiChat({messages, model='gpt-4o-mini', temperature=0.2}){
  try{
    const r = await axios.post('https://api.openai.com/v1/chat/completions',
      { model, messages, temperature },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    return (r.data.choices?.[0]?.message?.content || '').trim();
  }catch(e){
    console.error('OpenAI error:', e.response?.data || e.message);
    return '';
  }
}

// 任意：CAS（SymPy等）のAPI
async function casCompute(payload){
  if (!MATH_CAS_URL) return null;
  const r = await axios.post(MATH_CAS_URL, payload, { timeout: 12000 });
  return r.data;
}

/** ====== LaTeX → 読みやすい表記 ====== */
function sanitize(s=''){
  let t = s;
  t = t.replace(/¥/g,'\\').replace(/\$\$?/g,'').replace(/\\\(|\\\)/g,'');  // $, \( \)
  t = t.replace(/\\[,\;\!\:]/g,' ');
  t = t.replace(/\\left\s*/g,'(').replace(/\\right\s*/g,')');
  t = t.replace(/\\(text|mathrm|operatorname)\s*\{([^{}]*)\}/g,'$2');
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,'($1)/($2)');
  t = t.replace(/\\sqrt\{([^{}]+)\}/g,'√($1)');
  t = t.replace(/\\cdot/g,'×').replace(/\\times/g,'×').replace(/\\div/g,'÷');
  t = t.replace(/\\pm/g,'±').replace(/\\deg|\\degree/g,'°');
  t = t.replace(/\\to/g,'→').replace(/->/g,'→');
  const gm = {'\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\theta':'θ','\\lambda':'λ','\\mu':'µ','\\pi':'π','\\sigma':'σ','\\omega':'ω','\\Omega':'Ω','\\Delta':'Δ'};
  for (const k in gm) t = t.replace(new RegExp(k,'g'), gm[k]);
  t = t.replace(/([A-Za-z0-9])\^2\b/g,'$1²').replace(/([A-Za-z0-9])\^3\b/g,'$1³').replace(/\^\{([^{}]+)\}/g,'^$1');
  t = t.replace(/\\[A-Za-z]+/g,'');
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g,'$1 $2 $3');
  t = t.replace(/[ \t]+/g,' ').replace(/\s+\n/g,'\n').trim();
  return t;
}

/** ====== なんちゃって色強調（記号） ====== */
function withKumaoHighlights(text=''){
  let t = text;
  t = t.replace(/^(\s*)(公式[:：])/gmi, `$1🔷$2`);
  t = t.replace(/^(\s*)(重要|ポイント)[:：]/gmi, `$1🔶$2:`);
  t = t.replace(/(\n+)?【答え】/g, `\n🟧【答え】`);
  if (!/【答え】/.test(t)) {
    if (!/(ね！|よ！|よ〜|だよ|かな！|でしょう！)\s*$/.test(t)) {
      t += "\n\n（わからないところがあったら遠慮なくもう一度きいてね(●´ω｀●)）";
    }
  }
  return t.trim();
}

/** ====== 起動 ====== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🧪 StudyEye 理数系モード (final v1) on ${PORT}`));
