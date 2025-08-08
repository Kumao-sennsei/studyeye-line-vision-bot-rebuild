// ===== Kumao minimal stable index.js =====
// 機能: 画像→要点→ヒント→解法 / テキスト→一発解説
// くまお先生トーン / LaTeX禁止 / 自動ACKなし / 最小ログ / /selftest
// ENV: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY
// OPT: VERIFY_SIGNATURE("true"|"false"), OAI_MODEL(default "gpt-4o")

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
const isYes = (t) => /^(はい|ok|オッケー|おけ|了解|だいじょうぶ|大丈夫|いいよ|つづけ|続け|うん)$/i.test((t||"").trim());
const isNo  = (t) => /^(いいえ|いや|ちがう|違う|待って|まって|ストップ)$/i.test((t||"").trim());
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
【重要】数式はLaTeXや特殊記号は禁止。通常のテキスト表記で書くこと。
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

async function visionKeypoints(dataUrl){
  const prompt = `画像の問題文を読み取り、1)分野 2)与条件 3)求めるもの 4)重要な式/図 を日本語で簡潔に3-6行で要点化。${NO_LATEX}`;
  return oaiChat({
    model: OAI_MODEL,
    messages:[{ role:"user", content:[
      { type:"text", text: prompt },
      { type:"image_url", image_url:{ url: dataUrl } }
    ]}],
    temperature:0.2
  });
}
async function simpleText(p, temp=0.2){
  return oaiChat({ model: OAI_MODEL, messages:[{ role:"user", content:p }], temperature: temp });
}
async function hint1(parse){ return simpleText(`最初の一歩を1-2行で。式は最小限。${NO_LATEX}\n要点:\n${parse}`,0.2); }
async function hint2(parse){ return simpleText(`二歩目のヒントを1-3行で。決め手を短く。${NO_LATEX}\n要点:\n${parse}`,0.2); }
async function solution(parse){
  return simpleText(`段階的に解説。見出し→ステップ箇条書き(4-7)→最後に注意。各1-2文。${NO_LATEX}\n要点:\n${parse}`,0.3);
}
async function oneshot(q){
  const out = await simpleText(`質問を一発で解説→最後に次の一手を1行。${NO_LATEX}\n質問:\n${q}`,0.3);
  const ps = out.split("\n").filter(Boolean); return { summary: ps.slice(0,-1).join("\n")||out, next: ps.slice(-1)[0]||"他にもあれば送ってね！" };
}
async function checkAns(parse, ans){
  const out = await simpleText(`要点:\n${parse}\n学習者の回答:${ans}\n判定: CORRECT か WRONG のみ。${NO_LATEX}`,0);
  return /CORRECT/i.test(out);
}

// ===== State (in-memory) =====
const sess = new Map();
const getS = (u)=> sess.get(u) || { state:"START", parse:null };
const setS = (u,v)=> sess.set(u,v);

// ===== App =====
const app = express();
app.use(express.json({ verify: (req,_res,buf)=>{ req.rawBody = buf; } }));

app.get("/", (_req,res)=>res.send("kumao minimal up"));

app.get("/selftest", async (_req, res) => {
  try {
    const data = await oaiChat({ model: OAI_MODEL, messages:[{role:"user",content:"一言だけ: ok"}], temperature:0 });
    res.json({ ok:true, model: OAI_MODEL, reply: data.slice(0,50) });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/webhook", async (req,res)=>{
  try{
    if (VERIFY_SIGNATURE !== "false"){
      const sig = req.headers["x-line-signature"];
      const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
      if (hash !== sig) return res.status(403).send("forbidden");
    }
  }catch{ /* noop */ }
  res.status(200).end();

  const evs = req.body?.events || [];
  for (const ev of evs){ handle(ev).catch(e=>console.error("handle",e)); }
});

async function handle(event){
  if (event.type !== "message") return;
  const userId = event.source?.userId;
  const msg = event.message;
  let s = getS(userId);

  try{
    if (msg.type === "image"){
      const r = await fetch(`${LINE_API_BASE}/message/${msg.id}/content`, {
        headers:{ Authorization:`Bearer ${CHANNEL_ACCESS_TOKEN}` }
      });
      if (!r.ok) throw new Error("getContent failed: "+await r.text());
      const ab = await r.arrayBuffer(); const buf = Buffer.from(ab);
      const base64 = buf.toString("base64");
      const ctype = r.headers.get("content-type") || "image/jpeg";
      const dataUrl = `data:${ctype};base64,${base64}`;

      const parse = await visionKeypoints(dataUrl);
      s = { state:"HUMAN_CHECK", parse }; setS(userId,s);

      await linePush(userId, textMsgs([
        "まずは読み取った要点からいこっか。",
        formatKeypoints(parse),
        "うん、こんな読み取りでいけそう。ここから進めてみるね？"
      ]));
      return;
    }

    if (msg.type === "text"){
      const t = (msg.text||"").trim();

      if (isYes(t) && s.state === "HUMAN_CHECK"){
        const h1 = await hint1(s.parse);
        s = { state:"HINT1", parse: s.parse }; setS(userId,s);
        await linePush(userId, textMsgs([h1, "よし、この流れで次いこう。準備できたらOKって送ってね"]));
        return;
      }
      if (/^(ok|オッケー|続け|つづけ|次|next)$/i.test(t) && s.state === "HINT1"){
        const h2 = await hint2(s.parse);
        s = { state:"HINT2", parse: s.parse }; setS(userId,s);
        await linePush(userId, textMsgs([h2, "いい感じ。続けてOK？"]));
        return;
      }
      if (/^(ok|オッケー|続け|つづけ|次|next)$/i.test(t) && s.state === "HINT2"){
        const sol = await solution(s.parse);
        s = { state:"ASK_TRY", parse: s.parse }; setS(userId,s);
        await linePush(userId, textMsgs([...chunk(sol), "いったんここで区切るね。続きいこう🧸", "この先は任せてみてもいい？ちょっとだけやってみよっか"]));
        return;
      }

      if (/[0-9a-zA-Z()=+\-*/^|]/.test(t) && s.parse){
        const ok = await checkAns(s.parse, t);
        if (ok){
          await linePush(userId, textMsgs(["いいね👏 着眼バッチリ！", "別解も見てみる？"]));
          sess.delete(userId);
        }else{
          await linePush(userId, textMsgs(["惜しい…！ここだけ直そ。符号の向き、もう一回だけチェック！"]));
          s = { state:"ASK_TRY", parse: s.parse }; setS(userId,s);
        }
        return;
      }

      const { summary, next } = await oneshot(t);
      await linePush(userId, textMsgs([...chunk(summary), next]));
      sess.delete(userId);
      return;
    }
  }catch(e){
    console.error("handle error:", e?.stack || e);
    const msg =
      (String(e).includes("getContent failed")) ? "画像の取得でつまづいたみたい。端末に保存→その場で送信で試してみよっか。" :
      (String(e).includes("OpenAI")) ? "解析が混み合ってるみたい。少し待って同じ画像で再送してみて！" :
      "ちょっと引っかかったみたい。もう一回だけ送ってみよっか。";
    await linePush(userId, textMsgs(msg));
  }
}

function formatKeypoints(k){
  const t = (k && (k.includes("・") || k.includes("-"))) ? k : "・" + (k||"").replace(/\n/g,"\n・");
  return `要点まとめ🧸\n${t}`.slice(0, 4000);
}

app.listen(PORT, ()=>console.log(`kumao minimal listening on :${PORT}, model=${OAI_MODEL}`));
