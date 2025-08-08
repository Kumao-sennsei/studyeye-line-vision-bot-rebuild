// ===== Kumao One-Shot Bot (最小・解説のみ) =====
// LINE → 画像 or テキスト を受けたら、1回の解説だけ返す。会話/状態管理なし。
// ENV: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY
// OPT: VERIFY_SIGNATURE ("true"|"false"), OAI_MODEL (default "gpt-4o")

import express from "express";
import crypto from "crypto";

// ===== ENV =====
const {
  PORT = 3000,
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  VERIFY_SIGNATURE = "true",
  OAI_MODEL = "gpt-4o",
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

async function linePush(to, messages){
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) console.error("linePush", res.status, await res.text());
}

// ===== OpenAI =====
const NO_LATEX = `
【表記ルール】数式はLaTeX禁止。通常のテキスト表記で書くこと。
例: x^2+3x-4=0, 1/2, sqrt(3), a/b
「\\frac」「\\sqrt」「\\(\\)」「$$」などは禁止。
`;

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

async function explainFromImage(dataUrl){
  const prompt = `
あなたは優しい家庭教師くまお先生。画像の問題文を読み取り、要点をつかんだうえで「一回で」分かる解説を短く出す。
- まず要約1-2行 → すぐに解き方のコア手順を箇条書き3-6行 → 最後にワンポイント注意1行。
- 日本語で簡潔に。式は最小限。${NO_LATEX}
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

async function explainFromText(q){
  const prompt = `
あなたは優しい家庭教師くまお先生。次の質問を「一回で」わかる解説にしよう。
- 要点サマリ1-2行 → 手順の箇条書き3-6行 → 注意点1行。日本語。式は最小限。${NO_LATEX}
質問:
${q}
  `;
  return oaiChat({ model: OAI_MODEL, messages:[{ role:"user", content: prompt }], temperature:0.3 });
}

// ===== App =====
const app = express();
app.use(express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } }));

app.get("/", (_req,res)=>res.send("kumao oneshot up"));

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
        const r = await fetch(`${LINE_API_BASE}/message/${msg.id}/content`, {
          headers:{ Authorization:`Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (!r.ok) throw new Error("getContent failed: "+await r.text());
        const ab = await r.arrayBuffer(); const buf = Buffer.from(ab);
        const base64 = buf.toString("base64");
        const ctype = r.headers.get("content-type") || "image/jpeg";
        const dataUrl = `data:${ctype};base64,${base64}`;

        const out = await explainFromImage(dataUrl);
        await linePush(userId, textMsgs(chunk(out)));
      } else if (msg.type === "text"){
        const out = await explainFromText((msg.text||"").trim());
        await linePush(userId, textMsgs(chunk(out)));
      }
    } catch(e){
      console.error("handle error:", e?.stack || e);
      await linePush(userId, textMsgs("うまく解説できなかった…画像は“その場で送信”、テキストはもう一度送ってね。"));
    }
  }
});

app.listen(PORT, ()=>console.log(`kumao oneshot listening on :${PORT}, model=${OAI_MODEL}`));
