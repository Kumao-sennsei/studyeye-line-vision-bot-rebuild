// ===== くまお先生 ワンショット完全版（SyntaxError修正） =====
// 画像/テキスト → 一発解説。くまお先生トーン、答え明記、数式はLaTeX禁止（自動整形）。
// ENV: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY
// OPT: VERIFY_SIGNATURE("true"|"false"), OAI_MODEL("gpt-4o" 推奨)

import express from "express";
import crypto from "crypto";

// ===== ENV =====
const {
  PORT = process.env.PORT || 3000,
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  VERIFY_SIGNATURE = "true",
  OAI_MODEL = process.env.OAI_MODEL || "gpt-4o",
} = process.env;

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  console.error("Missing LINE env: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// ===== Helpers =====
const LINE_API_BASE = "https://api.line.me/v2/bot";
const textMsgs = (arr) => (Array.isArray(arr) ? arr : [arr]).map((t) => ({ type: "text", text: t }));
const chunk = (s, n=900) => { const out=[]; let r=s||""; while(r.length>n){out.push(r.slice(0,n)); r=r.slice(n);} if(r) out.push(r); return out; };

// === 数式整形（LaTeX→プレーン表記） ===
const MATH_RULES = `
【表記ルール】数式はLaTeX禁止。通常のテキスト表記で書くこと。
- 例: x^2+3x-4=0, 1/2, sqrt(3), (a)/(b), |x|, sin(x)
- 分数は ( ) と / 、累乗は ^ 、根号は sqrt()、絶対値は |x|
- 「\\frac, \\sqrt, \\cdot, \\times, \\pi, \\( \\), \\[ \\], $$」などは使わない
`;

function cleanMath(t = "") {
  return (t || "")
    // 分数/根号
    .replace(/\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g, "($1)/($2)")
    .replace(/\\sqrt\s*\{([^}]+)\}/g, "sqrt($1)")
    // 括弧
    .replace(/\\left\(/g, "(").replace(/\\right\)/g, ")")
    .replace(/\\left\[/g, "[").replace(/\\right\]/g, "]")
    .replace(/\\left\{/g, "{").replace(/\\right\}/g, "}")
    // 演算子・定数
    .replace(/\\cdot/g, "*").replace(/\\times/g, "*")
    .replace(/\\pi/g, "π")
    .replace(/\\leq/g, "<=").replace(/\\geq/g, ">=").replace(/\\ne/g, "!=")
    // 上下付き
    .replace(/\^\{\s*([^}]+)\s*\}/g, "^$1")
    .replace(/_\{\s*([^}]+)\s*\}/g, "_$1")
    // デリミタ削除
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$?/g, "")
    // 余白
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ===== LINE API =====
async function linePush(to, messages){
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) console.error("linePush", res.status, await res.text());
}

// ===== OpenAI =====
async function oaiChat(payload){
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){ console.error("OpenAI", res.status, data); throw new Error("OpenAI error"); }
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// 画像→一発解説（くまお先生トーン＋答え明記）
async function explainFromImage(dataUrl){
  const prompt = `
あなたは「くまお先生」🎓🧸 やさしく自然な会話で、絵文字も適度に使って解説します。
${MATH_RULES}
出力フォーマット（厳守）:
- ひとこと前置き（1行）😊
- 要点サマリ（1〜2行）
- 解き方のコア手順（3〜6行・箇条書き）
- ワンポイント注意（1行）
- 最後に必ず **「答え：...」** を明記（数式はプレーン表記）
この画像の問題を読み取って解説してね。
  `;
  return oaiChat({
    model: OAI_MODEL,
    messages:[{ role:"user", content:[
      { type:"text", text: prompt },
      { type:"image_url", image_url:{ url: dataUrl } }
    ]}],
    temperature:0.2
  });
}

// テキスト→一発解説（くまお先生トーン＋答え明記）
async function explainFromText(q){
  const prompt = `
あなたは「くまお先生」🎓🧸 やさしく自然な会話で、絵文字も適度に使って解説します。
${MATH_RULES}
出力フォーマット（厳守）:
- ひとこと前置き（1行）😊
- 要点サマリ（1〜2行）
- 解き方のコア手順（3〜6行・箇条書き）
- ワンポイント注意（1行）
- 最後に必ず **「答え：...」** を明記（数式はプレーン表記）
質問：
${q}
  `;
  return oaiChat({ model: OAI_MODEL, messages:[{ role:"user", content: prompt }], temperature:0.3 });
}

// ===== App =====
const app = express();
app.use(express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } }));

app.get("/", (_req,res)=>res.send("kumao oneshot up"));

// Webhook
app.post("/webhook", async (req,res)=>{
  try{
    if (VERIFY_SIGNATURE !== "false"){
      const sig = req.headers["x-line-signature"];
      const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
      if (hash !== sig) return res.status(403).send("forbidden");
    }
  }catch{ /* noop */ }
  // すぐACK（処理は後でpush）
  res.status(200).end();

  const events = req.body?.events || [];
  for (const ev of events){
    if (ev.type !== "message") continue;
    const userId = ev.source?.userId;
    const msg = ev.message;
    try {
      if (msg.type === "image"){
        // 画像取得→data:URL（安定）
        const r = await fetch(`${LINE_API_BASE}/message/${msg.id}/content`, {
          headers:{ Authorization:`Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (!r.ok) {
          const body = await r.text().catch(()=>"<no-body>");
          // ★ここをテンプレ文字列ではなく連結に変更してSyntaxError回避
          throw new Error('getContent failed: status=' + r.status + ' body=' + body);
        }
        const ab = await r.arrayBuffer(); const buf = Buffer.from(ab);
        const base64 = buf.toString("base64");
        const ctype = r.headers.get("content-type") || "image/jpeg";
        const dataUrl = 'data:' + ctype + ';base64,' + base64;

        const out = await explainFromImage(dataUrl);
        const cleaned = cleanMath(out);
        await linePush(userId, textMsgs(chunk(cleaned)));
      } else if (msg.type === "text"){
        const out = await explainFromText((msg.text||"").trim());
        const cleaned = cleanMath(out);
        await linePush(userId, textMsgs(chunk(cleaned)));
      }
    } catch(e){
      console.error("handle error:", e?.stack || e);
      await linePush(userId, textMsgs("うまく解説できなかった…🙏 画像は“その場で送信”で、もう一度試してみてね。"));
    }
  }
});

app.listen(PORT, ()=>console.log('kumao oneshot listening on :' + PORT + ', model=' + OAI_MODEL));
