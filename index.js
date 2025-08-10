const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');

/** ========= 環境変数 ========= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET       || process.env.LINE_CHANNEL_SECRET
};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!config.channelAccessToken || !config.channelSecret || !OPENAI_API_KEY) {
  console.error('❌ ENV不足: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY');
  process.exit(1);
}

/** ========= LINE/Server 準備 ========= */
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
app.get('/healthz', (_, res) => res.status(200).json({ ok: true }));

/** ========= 入口イベント ========= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  if (event.message.type === 'text') {
    // 通常テキスト会話：〆に「【答え】」は付けない
    const text = event.message.text || '';
    const reply = await converseTextFlow(text);
    return client.replyMessage(event.replyToken, { type: 'text', text: reply });
  }

  if (event.message.type === 'image') {
    // 画像問題：最後に【答え】… を必ず一行で
    const reply = await imageSolveFlow(event.message.id);
    return client.replyMessage(event.replyToken, { type: 'text', text: reply });
  }

  // その他
  return client.replyMessage(event.replyToken, { type: 'text', text: '今はテキストと画像に対応してるよ(●´ω｀●)' });
}

/** ========= 数学強化ロジック（①②③） =========
 * ① 内部ではLaTeXのまま推論 → 最後に可読整形
 * ② 数学っぽいときは高精度モデル（gpt-4o）/ それ以外は軽量（gpt-4o-mini）
 * ③ 検算：別アプローチ指示で再計算→一致しなければ再試行
 */
function isMathy(s='') {
  return /∫|√|\^|\/|=|≤|≥|Σ|Π|sin|cos|tan|log|ln|微分|積分|方程式|平方|二次|三角関数|ベクトル|行列|dy\/dx|d\/dx|dx|dy/.test(s);
}

function buildSystemPrompt({answerMode}) {
  // answerMode: 'image' | 'text'
  // 画像のときだけ最後に【答え】… を必須、テキスト会話は付けない
  return [
    "あなたは『神仙人くまお先生』。やさしく面白く、絵文字はほどほど。日本語で解説。",
    "数式は本文ではLaTeXでもよいが、最終的な返答はLINEで崩れない記号表記に整形すること（√(), (a)/(b), x^n, ∫[a→b] f(x) dx など）。",
    "手順は番号付きで、何をしているかを短文で説明。式はできるだけ短く分割。",
    (answerMode === 'image'
      ? "最後に必ず一行で「【答え】...」を明記。"
      : "日常会話や説明だけのときは最後に「【答え】」を付けない。")
  ].join("\n");
}

function buildMathSolvePrompt(userText) {
  // 二重計算＋検算（内容はモデル内部で行わせ、最終出力は簡潔）
  return [
    "次の問題を解いてください。まず通常の方針で計算し、別の観点で必ず検算してください。",
    "両者が一致しない場合は手順を見直し、再計算して整合性のある最終結果を出してください。",
    "途中式は短く区切って、等号の前後にスペースを入れるなど可読性を重視してください。",
    "最後の返答は、LINEで崩れない記号表記に整形してください（√(), (a)/(b), x^n など）。",
    "",
    `【問題】\n${userText}`
  ].join("\n");
}

function buildGeneralPrompt(userText) {
  return [
    "以下の内容を、くまお先生の優しい会話口調でわかりやすく説明してください。",
    "数式が出ても日常会話ではLaTeXは使わず、読みやすい記号表記に整形（√(), (a)/(b), x^n）。",
    "最後に【答え】は付けないで自然に締めること。",
    "",
    `【話題】\n${userText}`
  ].join("\n");
}

/** ========= OpenAI呼び出し ========= */
async function openaiChat({messages, model='gpt-4o-mini', temperature=0.2}) {
  try {
    const r = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model, messages, temperature },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return (r.data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('OpenAI error:', e.response?.data || e.message);
    return '';
  }
}

/** ========= サニタイザ（LaTeX→読みやすい表記） ========= */
function sanitizeText(s='') {
  let t = s;
  t = t.replace(/¥/g, "\\");               // JPキーボード
  t = t.replace(/\$\$?/g, "");             // $ $$
  t = t.replace(/\\\(|\\\)/g, "");         // \( \)
  t = t.replace(/\\[,\;\!\:]/g, " ");      // \, \; etc
  t = t.replace(/\\left\s*/g, "(").replace(/\\right\s*/g, ")");
  t = t.replace(/\\(text|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$2");
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  t = t.replace(/\\cdot/g, "×").replace(/\\times/g, "×").replace(/\\div/g, "÷");
  t = t.replace(/\\pm/g, "±").replace(/\\deg|\\degree/g, "°");
  t = t.replace(/\\to/g, "→").replace(/->/g, "→");
  // Greek subset
  const gm = {'\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\theta':'θ','\\lambda':'λ','\\mu':'µ','\\pi':'π','\\sigma':'σ','\\omega':'ω','\\Omega':'Ω','\\Delta':'Δ'};
  for (const k in gm) t = t.replace(new RegExp(k, 'g'), gm[k]);
  // superscripts
  t = t.replace(/([A-Za-z0-9])\^2\b/g, "$1²").replace(/([A-Za-z0-9])\^3\b/g, "$1³").replace(/\^\{([^{}]+)\}/g, "^$1");
  // remove stray commands
  t = t.replace(/\\[A-Za-z]+/g, "");
  // operator spacing
  t = t.replace(/([0-9A-Za-z\)\]])([=\+\-×÷\/])([0-9A-Za-z\(\[])/g, "$1 $2 $3");
  // clean spaces
  t = t.replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
  return t;
}

/** ========= テキスト会話フロー（答えは付けない） ========= */
async function converseTextFlow(userText) {
  const mathy = isMathy(userText);
  const system = buildSystemPrompt({answerMode: 'text'});
  const prompt = mathy ? buildMathSolvePrompt(userText) : buildGeneralPrompt(userText);
  const model = mathy ? 'gpt-4o' : 'gpt-4o-mini';

  // 1回目（通常計算 or 会話）
  const first = await openaiChat({ messages: [
    { role: 'system', content: system },
    { role: 'user',   content: prompt }
  ], model });

  if (!mathy) {
    // 会話はそのまま整形して返す（【答え】禁止）
    const out = sanitizeText(first).replace(/\n?【答え】.*/gs, "").trim();
    return withKumaoHighlights(out);
  }

  // 数学は検算ステップを追加（別方針で再計算）
  const verify = await openaiChat({ messages: [
    { role: 'system', content: system },
    { role: 'user',   content:
      "今出した解の正しさを、別の観点（式の展開や別の定理・近似など）で短く検算して。" +
      "万一食い違いがあれば再計算して一致させ、最終的な簡潔な解説にまとめ直して。"
    }
  ], model: 'gpt-4o', temperature: 0.1 });

  // 結果を整形して、【答え】があっても削除（テキスト会話では出さない）
  const merged = sanitizeText(`${first}\n\n🔶 検算メモ\n${verify}`);
  const withoutAnswerTail = merged.replace(/\n?【答え】.*/gs, "").trim();
  return withKumaoHighlights(withoutAnswerTail);
}

/** ========= 画像問題フロー（最後に【答え】必須） ========= */
async function imageSolveFlow(messageId) {
  try {
    const stream = await client.getMessageContent(messageId);
    const bufs = [];
    await new Promise((resolve, reject) => {
      stream.on('data', c => bufs.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const b64 = Buffer.concat(bufs).toString('base64');

    const system = buildSystemPrompt({answerMode: 'image'});
    const prompt = [
      "画像の問題を読み取り、手順を番号付きで丁寧に解説してください。",
      "数学はまず通常計算→別観点で検算→一致しない場合は再計算。",
      "最後は必ず一行で【答え】... を明記（単位があれば単位も）。",
      "本文の最終出力は、LINEで崩れない記号表記に整形すること（√(), (a)/(b), x^n など）。"
    ].join("\n");

    // 高精度モデル固定
    const content = await openaiChat({
      model: 'gpt-4o',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
        ]}
      ]
    });

    // 最後に【答え】があることを保証（無ければ抽出要求）
    let out = sanitizeText(content);
    if (!/【答え】/.test(out)) {
      const fix = await openaiChat({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: "上記の結果から最終値を抽出し、一行で【答え】... を必ず付けて簡潔にまとめ直してください。" }
        ]
      });
      out = sanitizeText(fix);
    }
    // 画像回答は【答え】を残す
    return withKumaoHighlights(out);
  } catch (e) {
    console.error('image flow error:', e.message);
    return '画像を読み取れなかったよ…もう一度送ってみてね(；ω；)';
  }
}

/** ========= くまお先生ハイライト（方式③：色の代わりに記号） =========
 * 🔶【重要】、🔷【公式】、🟧【答え】 を自然に埋め込む（重複しないよう軽く整形）
 */
function withKumaoHighlights(text='') {
  // 既にユーザ向けに入ってたら尊重。無ければ軽く付ける。
  let t = text;

  // 「公式:」「式:」などの行頭に🔷を付与（重複回避）
  t = t.replace(/^(\s*)(公式[:：])/gmi, `$1🔷$2`);
  // 「重要」「ポイント」などに🔶
  t = t.replace(/^(\s*)(重要|ポイント)[:：]/gmi, `$1🔶$2:`);
  // 既に【答え】がある場合は🟧を付ける（画像フローで主に使われる）
  t = t.replace(/(\n+)?【答え】/g, `\n🟧【答え】`);

  // くまお先生の優しい締め（会話の場合のみ柔らかく）
  if (!/【答え】/.test(t)) {
    // 末尾に優しい一文が無ければ足す（やりすぎ防止）
    if (!/(ね！|よ！|よ〜|だよ|かな！|でしょう！)\s*$/.test(t)) {
      t += "\n\n（わからないところがあったら遠慮なくもう一度きいてね(●´ω｀●)）";
    }
  }
  return t.trim();
}

/** ========= 起動 ========= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐻 Kumao-sensei FINAL on ${PORT}`));
