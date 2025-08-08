// index.js くまお先生ボット “フル実装・Railway変数名対応版”
// 画像→段階対話、テキスト→一発解説、自然会話、即時ACK+Push分割
// ENV: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN / OPENAI_API_KEY / VERIFY_SIGNATURE? / REDIS_URL?

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

// ====== ENV ======
const {
  PORT = 3000,
  CHANNEL_SECRET,
  CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  VERIFY_SIGNATURE = "true",
  REDIS_URL, // optional (eg. Upstash rediss://)
} = process.env;

if (!CHANNEL_SECRET || !CHANNEL_ACCESS_TOKEN) {
  console.error("LINE環境変数が未設定です: CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY が未設定です");
  process.exit(1);
}

// ====== Optional Redis ======
let redis = null;
if (REDIS_URL) {
  const { createClient } = await import("redis");
  redis = createClient({ url: REDIS_URL, socket: { tls: REDIS_URL.startsWith("rediss://") } });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();
  console.log("Redis connected");
}

// ====== Session ======
const memSession = new Map();
async function getSession(userId) {
  if (redis) {
    const s = await redis.get(`sess:${userId}`);
    return s ? JSON.parse(s) : { state: "START", payload: {} };
  }
  return memSession.get(userId) || { state: "START", payload: {} };
}
async function setSession(userId, s) {
  if (redis) return redis.set(`sess:${userId}`, JSON.stringify(s), { EX: 60 * 60 * 12 });
  memSession.set(userId, s);
}
async function clearSession(userId) {
  if (redis) return redis.del(`sess:${userId}`);
  memSession.delete(userId);
}

// ====== Helpers ======
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isYes = (t) => /^(はい|ok|オッケー|おけ|了解|だいじょうぶ|大丈夫|いいよ|つづけ|続け|うん)/i.test((t||"").trim());
const isNo  = (t) => /^(いいえ|いや|ちがう|違う|待って|まって|ストップ|一回止め)/i.test((t||"").trim());
const looksLikeAnswer = (t) => /[0-9a-zA-Zぁ-んァ-ヶ一-龥=+\-*/^()π√％]/.test(t || "");
const chunkText = (text, size = 900) => {
  const out = [];
  let rest = text || "";
  while (rest.length > size) { out.push(rest.slice(0, size)); rest = rest.slice(size); }
  if (rest) out.push(rest);
  return out;
};

// ====== Templates ======
const TEMPLATES = {
  confirm_steps: [
    "この問題、ここまでの読み取りで合ってそう？",
    "ポイントはこんな感じ。続けていい？",
    "ざっくり要点はここ！ いったんここまでどう？"
  ],
  ask_try_alone: [
    "ここからは一人でいけそう？試してみる？",
    "この先は任せてよさそう？ 2分タイマー回すよ⏱",
    "この一手は自分で置いてみる？"
  ],
  praise: [
    "いいね👍 着眼が素晴らしい！",
    "完璧✨ その流れで合ってるよ！",
    "ナイス！筋が通ってる🧸"
  ],
  near_miss: [
    "発想は合ってる👏 この一歩だけ修正しよう（符号／式の並べ方）",
    "惜しい！ここで条件をもう1回だけ見直そう",
    "流れOK。計算のここだけ丁寧にいこう"
  ],
  mid_check: [
    "ここまでで違和感あるとこある？",
    "認識ズレないかだけチェックさせて！",
    "道筋の見取り図は合ってる？"
  ],
};

// ====== LINE API ======
const LINE_API_BASE = "https://api.line.me/v2/bot";
async function lineReply(replyToken, messages) {
  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error("lineReply error:", res.status, await res.text());
}
async function linePush(to, messages) {
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) console.error("linePush error:", res.status, await res.text());
}
const textMsgs = (arr) => (Array.isArray(arr) ? arr : [arr]).map((t) => ({ type: "text", text: t }));

// ====== OpenAI (Vision + Text) ======
async function oaiChat(payload) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("OpenAI error: " + JSON.stringify(data));
  return data?.choices?.[0]?.message?.content?.trim() || "";
}
async function oaiVisionKeypoints(imageBase64) {
  const prompt = `あなたは塾講師のくまお先生。画像の問題文を読み取り、
1) 問題の種類/分野
2) 与条件（記号や定数）
3) 求めるもの
4) 重要な式・図の読み取り
を日本語で簡潔に、箇条書き3-6行で要点化してください。`;
  return await oaiChat({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "input_image", image: imageBase64 }
      ],
    }],
    temperature: 0.2,
  });
}
async function simpleOaiText(prompt, temperature = 0.2) {
  return await oaiChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature });
}
async function oaiHint1(parseText) {
  const p = `あなたはくまお先生。次の要点から、最初の一歩のヒントを1-2行で。式は最小限。\n要点:\n${parseText}`;
  return await simpleOaiText(p, 0.2);
}
async function oaiHint2(parseText) {
  const p = `あなたはくまお先生。次の要点から、二歩目のヒントを1-3行で。解法を確定させる決め手を短く。\n要点:\n${parseText}`;
  return await simpleOaiText(p, 0.2);
}
async function oaiSolution(parseText) {
  const p = `あなたはくまお先生。次の問題を段階的に解説。
- 見出し1行 → ステップ箇条書き(4-7) → 最後にワンポイント注意
- 各ステップは1-2文、長文禁止、数式は簡潔
要点:\n${parseText}`;
  return await simpleOaiText(p, 0.3);
}
async function oaiCheckAnswer(parseText, userAnswer) {
  const p = `要点:\n${parseText}\n\n学習者の回答: ${userAnswer}\n判定: 「CORRECT」または「WRONG」だけを出力。`;
  const out = await simpleOaiText(p, 0);
  return /CORRECT/i.test(out);
}
async function oaiMicroReteach(parseText, userAnswer) {
  const p = `要点:\n${parseText}\n\n学習者の回答: ${userAnswer}\nどこで躓いたかを1点だけ指摘→修正のコツを2行で。式は最小限。`;
  return await simpleOaiText(p, 0.3);
}
async function oaiOneShotExplain(text) {
  const p = `あなたはくまお先生。次の質問を一発でわかりやすく解説し、最後に次の一手を1行で提案。\n質問:\n${text}`;
  const out = await simpleOaiText(p, 0.3);
  const parts = out.split("\n").filter(Boolean);
  const summary = parts.slice(0, -1).join("\n") || out;
  const nextStep = parts.slice(-1)[0] || "他にも気になる点があれば送ってね！";
  return { summary, nextStep };
}

// ====== State Machine ======
function reduceState(curr, intent, payload = {}) {
  const s = curr || { state: "START", payload: {} };
  switch (s.state) {
    case "START":
      if (intent === "IMAGE") return save("PARSE", { image: payload.image });
      if (intent === "TEXT")  return save("SOLVE_ONESHOT", { text: payload.text });
      break;
    case "PARSE":
      if (intent === "PARSE_DONE") return save("HUMAN_CHECK", { ...s.payload, parse: payload.parse });
      break;
    case "HUMAN_CHECK":
      if (intent === "YES") return save("HINT1", s.payload);
      if (intent === "NO")  return save("REVISE", s.payload);
      break;
    case "HINT1":
      if (intent === "CONTINUE") return save("HINT2", s.payload);
      break;
    case "HINT2":
      if (intent === "CONTINUE") return save("SOLUTION", s.payload);
      break;
    case "SOLUTION":
      if (intent === "ASK_TRY") return save("TRY_ALONE", s.payload);
      break;
    case "TRY_ALONE":
      if (intent === "ANSWER") return save("CHECK_ANSWER", { ...s.payload, answer: payload.answer });
      break;
    case "CHECK_ANSWER":
      if (intent === "CORRECT") return save("PRAISE", s.payload);
      if (intent === "WRONG")   return save("RETEACH", s.payload);
      break;
    case "REVISE":
      if (intent === "REVISED") return save("HUMAN_CHECK", { ...s.payload, parse: payload.parse });
      break;
  }
  return s;
  function save(state, p) { return { state, payload: p }; }
}

// ====== Express ======
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/", (_req, res) => res.status(200).send("kumao-vision-bot up"));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.post("/webhook", async (req, res) => {
  if (VERIFY_SIGNATURE !== "false") {
    const signature = req.headers["x-line-signature"];
    const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
    if (hash !== signature) { console.warn("Signature mismatch"); return res.status(403).send("forbidden"); }
  }
  // 即ACK（LINEの3秒制限対策）
  res.status(200).end();

  const events = req.body?.events || [];
  for (const ev of events) handleEvent(ev).catch((e) => console.error("handleEvent error:", e));
});

async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const message = event.message;

  // すぐ軽い返事（空応答回避）
  await lineReply(replyToken, textMsgs("うけとったよ🧸 少し考えるね…"));

  let s = await getSession(userId);

  try {
    if (message.type === "image") {
      // 画像バイナリ取得 → Base64
      const contentRes = await fetch(`${LINE_API_BASE}/message/${message.id}/content`, {
        headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
      });
      if (!contentRes.ok) throw new Error("getContent failed: " + (await contentRes.text()));
      const buf = Buffer.from(await contentRes.arrayBuffer());
      const base64 = buf.toString("base64");

      s = reduceState(s, "IMAGE", { image: base64 }); await setSession(userId, s);

      const parse = await oaiVisionKeypoints(base64);
      s = reduceState(s, "PARSE_DONE", { parse }); await setSession(userId, s);

      await linePush(userId, [
        ...textMsgs(formatKeypoints(parse)),
        ...textMsgs(pick(TEMPLATES.confirm_steps)),
      ]);
      return;
    }

    if (message.type === "text") {
      const text = (message.text || "").trim();

      // YES / NO
      if (isYes(text)) {
        s = reduceState(s, "YES"); await setSession(userId, s);
        if (s.state === "HINT1") {
          const t1 = await oaiHint1(s.payload.parse);
          await linePush(userId, [...textMsgs(t1), ...textMsgs("続けようか？（OKで進むよ）")]);
          return;
        }
      } else if (isNo(text)) {
        s = reduceState(s, "NO"); await setSession(userId, s);
        await linePush(userId, textMsgs("よし修正するね。どの部分が違いそう？（条件／図形／式）"));
        return;
      }

      // 進行キーワード
      if (/^(ok|オッケー|続け|つづけ|次|next)$/i.test(text)) {
        s = reduceState(s, "CONTINUE"); await setSession(userId, s);
        if (s.state === "HINT2") {
          const t2 = await oaiHint2(s.payload.parse);
          await linePush(userId, [...textMsgs(t2), ...textMsgs("もう一歩いこう。OKなら続けるよ")]);
          return;
        }
        if (s.state === "SOLUTION") {
          const sol = await oaiSolution(s.payload.parse);
          const chunks = chunkText(sol);
          await linePush(userId, [
            ...textMsgs(chunks),
            ...textMsgs("ここで区切るね🐾"),
            ...textMsgs(pick(TEMPLATES.ask_try_alone)),
          ]);
          s = reduceState(s, "ASK_TRY"); await setSession(userId, s);
          return;
        }
      }

      // 自力回答
      if (looksLikeAnswer(text)) {
        s = reduceState(s, "ANSWER", { answer: text }); await setSession(userId, s);

        if (!s.payload?.parse) {
          // 画像ルート未通過 → 一発解説
          const { summary, nextStep } = await oaiOneShotExplain(text);
          await linePush(userId, [...textMsgs(chunkText(summary)), ...textMsgs(nextStep)]);
          await clearSession(userId);
          return;
        }

        const ok = await oaiCheckAnswer(s.payload.parse, text);
        s = reduceState(s, ok ? "CORRECT" : "WRONG"); await setSession(userId, s);

        if (s.state === "PRAISE") {
          await linePush(userId, [...textMsgs(pick(TEMPLATES.praise)), ...textMsgs("仕上げに別解も見てみる？")]);
          await clearSession(userId);
          return;
        }
        if (s.state === "RETEACH") {
          const micro = await oaiMicroReteach(s.payload.parse, text);
          await linePush(userId, [...textMsgs(pick(TEMPLATES.near_miss)), ...textMsgs(micro)]);
          s = { state: "TRY_ALONE", payload: s.payload }; await setSession(userId, s);
          return;
        }
      }

      // テキスト一発解説（フォールバックも兼ねる）
      const { summary, nextStep } = await oaiOneShotExplain(text);
      await linePush(userId, [...textMsgs(chunkText(summary)), ...textMsgs(nextStep)]);
      await clearSession(userId);
      return;
    }
  } catch (err) {
    console.error("handleEvent inner error:", err);
    await linePush(userId, textMsgs("内部でエラーがあったよ…ちょっと待っててね🧸"));
  }
}

function formatKeypoints(k) {
  const t = (k.includes("・") || k.includes("-")) ? k : "・" + k.replace(/\n/g, "\n・");
  return `要点まとめ🧸\n${t}`.slice(0, 4000);
}

// ====== Start ======
app.listen(PORT, () => { console.log(`kumao-vision-bot listening on :${PORT}`); });
