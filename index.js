// ===== Kumao rollback-like (絵文字多め・くま先生トーン) =====
// 画像/テキスト → 一発解説。面白くやさしい会話、絵文字多め🧸✨
// 最後に必ず「答え：...」。数式はプレーン表記へ自動整形。
// 画像取得は getContent 1回リトライ。
// ENV: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY
// OPT: VERIFY_SIGNATURE("true"|"false"), OAI_MODEL(default "gpt-4o")

import express from "express";
import crypto from "crypto";

const {
  PORT = 3000,
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  VERIFY_SIGNATURE = "true",
  OAI_MODEL = "gpt-4o",
} = process.env;

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) { console.error("Missing LINE env"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const LINE_API_BASE = "https://api.line.me/v2/bot";
const textMsgs = (arr) => (Array.isArray(arr) ? arr : [arr]).map((t) => ({ type: "text", text: t }));
const chunk = (s, n=900) => { const out=[]; let r=s||""; while(r.length>n){out.push(r.slice(0,n)); r=r.slice(n);} if(r) out.push(r); return out; };

// --- 数式表記ルール（LaTeX禁止・プレーン表記） ---
const MATH_RULES = `
【表記ルール】数式はLaTeX禁止。通常のテキスト表記で書くこと。
- 例: x^2+3x-4=0, 1/2, sqrt(3), (a)/(b), |x|, sin(x)
- 分数は ( ) と / 、累乗は ^ 、根号は sqrt()、絶対値は |x|
- 「\\frac, \\sqrt, \\cdot, \\times, \\pi, \\( \\), \\[ \\], $$」などは使わない
`;

function cleanMath(t=""){
  return (t||"")
    .replace(/\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g,"($1)/($2)")
    .replace(/\\sqrt\s*\{([^}]+)\}/g,"sqrt($1)")
    .replace(/\\left\(/g,"(").replace(/\\right\)/g,")")
    .replace(/\\left\[/g,"[").replace(/\\right\]/g,"]")
    .replace(/\\left\{/g,"{").replace(/\\right\}/g,"}")
    .replace(/\\cdot/g,"*").replace(/\\times/g,"*").replace(/\\pi/g,"π")
    .replace(/\\leq/g,"<=").replace(/\\geq/g,">=").replace(/\\ne/g,"!=")
    .replace(/\^\{\s*([^}]+)\s*\}/g,"^$1").replace(/_\{\s*([^}]+)\s*\}/g,"_$1")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$?/g,"")
    // 軽い可読性スペース
    .replace(/(?<=\d)([+\-*/=])(?=\d)/g," $1 ")
    .replace(/\s{2,}/g," ")
    .replace(/[ \t]+\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n");
}

// OpenAI Chat
async function oaiChat(payload){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok){ console.error("OpenAI", r.status, data); throw new Error("OpenAI error"); }
  return (data?.choices?.[0]?.message?.content ?? "").trim();
}

// くま先生トーン（絵文字多め・面白く優しく）
function kumaoPromptIntro(){
  return [
    "あなたは『くまお先生』🧸✨ ツッコミ少々、やさしさ多め、面白く元気に！",
    "絵文字は多めにOK🎯📚🧠✨（多用しすぎず読みやすさは守る）",
    "むずかしい言葉は小学生にも伝わる言い換えにしてね。",
    "出力はこの順で厳守：",
    "1) ひとこと前置き（1行）→ 例:『よし、任せて！一緒に解こう🐻』",
    "2) 要点サマリ（1〜2行）",
    "3) 解き方のコア手順（3〜6行・箇条書き／各行に軽く絵文字OK）",
    "4) ワンポイント注意（1行／失敗しやすい所を一言）",
    "5) 最後に必ず【答え：...】を1行で明記（数式はプレーン表記）",
    MATH_RULES
  ].join("\n");
}

// 画像→一発解説
async function explainImage(imageInput){
  const prompt = kumaoPromptIntro() + "\nこの画像の問題を読み取って、上の形式で解説して！";
  return oaiChat({
    model: OAI_MODEL,
    messages:[{ role:"user", content:[
      { type:"text", text: prompt },
      { type:"image_url", image_url:{ url: imageInput } }
    ]}],
    temperature: 0.35
  });
}

// テキスト→一発解説
async function explainText(q){
  const prompt = kumaoPromptIntro() + "\n質問：\n" + q;
  return oaiChat({ model: OAI_MODEL, messages:[{ role:"user", content: prompt }], temperature: 0.4 });
}

// LINE Push
async function linePush(to, messages){
  const r = await fetch(LINE_API_BASE + "/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ to, messages })
  });
  if (!r.ok) console.error("linePush", r.status, await r.text().catch(()=>"<no-body>"));
}

// fetch LINE image with one retry
async function fetchLineImage(messageId){
  const url = LINE_API_BASE + "/message/" + messageId + "/content";
  for (let i=0;i<2;i++){
    const r = await fetch(url, { headers: { Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN } });
    if (r.ok) {
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const base64 = buf.toString("base64");
      const ctype = r.headers.get("content-type") || "image/jpeg";
      return "data:" + ctype + ";base64," + base64;
    }
    if (i===0) await new Promise(res=>setTimeout(res, 300));
  }
  const r = await fetch(url, { headers: { Authorization: "Bearer " + CHANNEL_ACCESS_TOKEN } });
  const body = await r.text().catch(()=>"<no-body>");
  const status = r.status || "unknown";
  throw new Error("getContent failed: status=" + status + " body=" + body);
}

const app = express();
app.use(express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } }));
app.get("/", (_req,res)=>res.send("kumao emoji-tone up"));

app.post("/webhook", async (req,res)=>{
  try{
    if (VERIFY_SIGNATURE !== "false"){
      const sig = req.headers["x-line-signature"];
      const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
      if (hash !== sig) return res.status(403).send("forbidden");
    }
  }catch{}
  res.status(200).end();

  const events = req.body?.events || [];
  for (const ev of events){
    if (ev.type !== "message") continue;
    const userId = ev.source?.userId;
    const msg = ev.message;
    try{
      if (msg.type === "image"){
        const dataUrl = await fetchLineImage(msg.id);
        const out = await explainImage(dataUrl);
        await linePush(userId, textMsgs(chunk(cleanMath(out))));
      } else if (msg.type === "text"){
        const out = await explainText((msg.text||"").trim());
        await linePush(userId, textMsgs(chunk(cleanMath(out))));
      }
    }catch(e){
      console.error("handle error:", e?.stack || e);
      const s = String(e);
      let advice = "うまく解説できなかった…🙏 画像は“その場で撮影して送信”で、もう一度試してみてね。";
      if (s.includes("status=401") || s.includes("status=403")) advice = "画像の取得でエラー（権限/トークン）。Channel access token(長期)を再発行して環境変数に入れ直してみてね。";
      if (s.includes("status=404")) advice = "画像が見つからなかったみたい。転送やアルバム共有ではなく、“その場で撮影”で試してみてね📷";
      await linePush(userId, textMsgs(advice));
    }
  }
});

app.listen(PORT, ()=>console.log("kumao emoji-tone listening on :" + PORT + ", model=" + OAI_MODEL));
