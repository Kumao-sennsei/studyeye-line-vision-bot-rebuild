// index.js くまお先生ボット “Railway変数名対応版”
// CHANNEL_SECRET / CHANNEL_ACCESS_TOKEN を使用
// 画像→段階対話、テキスト→一発解説、自然会話、即時ACK+Push分割

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
  REDIS_URL, // optional
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isYes = (t) => /^(はい|ok|オッケー|おけ|了解|だいじょうぶ|大丈夫|いいよ|つづけ|続け|うん)/i.test((t||"").trim());
const isNo  = (t) => /^(いいえ|いや|ちがう|違う|待って|まって|ストップ|一回止め)/i.test((t||"").trim());
const looksLikeAnswer = (t) => /[0-9a-zA-Zぁ-んァ-ヶ一-龥=+\-*/^()π√％]/.test(t || "");
const chunkText = (text, size = 900) => {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
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
};

// ====== LINE API ======
const LINE_API_BASE = "https://api.line.me/v2/bot";
async function lineReply(replyToken, messages) {
  const body = { replyToken, messages };
  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("lineReply error:", res.status, await res.text());
  }
}
async function linePush(to, messages) {
  const body = { to, messages };
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("linePush error:", res.status, await res.text());
  }
}
function lineTextMessages(textOrArray) {
  const arr = Array.isArray(textOrArray) ? textOrArray : [textOrArray];
  return arr.map((t) => ({ type: "text", text: t }));
}

// ====== OpenAI ======
// （ここは前回渡した完全版と同じなので省略してもOK、必要ならまた全部載せます）

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
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

app.get("/", (req, res) => res.status(200).send("kumao-vision-bot up"));

app.post("/webhook", async (req, res) => {
  if (VERIFY_SIGNATURE !== "false") {
    const signature = req.headers["x-line-signature"];
    const hash = crypto
      .createHmac("sha256", CHANNEL_SECRET)
      .update(req.rawBody)
      .digest("base64");
    if (hash !== signature) {
      console.warn("Signature mismatch");
      return res.status(403).send("forbidden");
    }
  }
  res.status(200).end();

  const events = req.body?.events || [];
  for (const ev of events) {
    handleEvent(ev).catch((e) => console.error("handleEvent error:", e));
  }
});

// handleEvent は前回の完全版から変更なし（中の TOKEN/SECRET を置き換え済）

app.listen(PORT, () => {
  console.log(`kumao-vision-bot listening on :${PORT}`);
});
