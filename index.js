// index.js くまお先生ボット
// フル実装：自然会話トーン（受領メッセなし）、LaTeX禁止、画像→段階対話／テキスト→一発解説、即時ACK+Push分割、詳細ログ
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
  try {
    const { createClient } = await import("redis");
    redis = createClient({ url: REDIS_URL, socket: { tls: REDIS_URL.startsWith("rediss://") } });
    redis.on("error", (err) => console.error("Redis error:", err));
    await redis.connect();
    console.log("Redis connected");
  } catch (e) {
    console.error("Redis init failed (続行します):", e);
    redis = null;
  }
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
  if (redis) return redis.set(`sess:${userId}`, JSON.stringify(s), { EX: 60 * 60 * 12 }); // 12h
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

// ====== くまお先生トーン ======
const TEMPLATES = {
  confirm_steps: [
    "うん、こんな読み取りでいけそう。ここから進めてみるね？",
    "要点はこんな感じ。流れ、このままで大丈夫そう？",
    "ざっくり道筋はこれ。ズレてたらここで直そっか？"
  ],
  ask_try_alone: [
    "この先は任せてみてもいい？ちょっとだけやってみよっか",
    "一手だけ自分で置いてみる？できそうならやってみよ",
    "いい感じ！ここはたかちゃんの番だね、やってみよう✨"
  ],
  praise: [
    "いいね👏 着眼バッチリ！",
    "完璧だよ✨ その進め方で合ってる！",
    "ナイス！流れきれいだね🧸"
  ],
  near_miss: [
    "惜しい…！ここだけ直そ。符号の向き、もう一回だけチェック！",
    "発想OK。式の並びだけ整えよう、そしたら通るよ",
    "あと一歩！条件の読み替えをもう一度だけ確認しよ"
  ],
  mid_check: [
    "ここまで違和感ない？",
    "この見取り図でいけそう？",
    "進め方、ズレてない感じする？"
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
  if (!res.ok) console.error("lineReply error:", res.status, await safeText(res));
}
async function linePush(to, messages) {
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) console.error("linePush error:", res.status, await safeText(res));
}
const textMsgs = (arr) => (Array.isArray(arr) ? arr : [arr]).map((t) => ({ type: "text", text: t }));
async function safeText(res) { try { return await res.text(); } catch { return "<no-body>"; } }

// ====== OpenAI（LaTeX禁止） ======
async function oaiChat(payload) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("OpenAI error status:", res.status);
    console.error("OpenAI error body:", JSON.stringify(data));
    throw new Error("OpenAI error");
  }
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

const NO_LATEX_RULES = `
【重要】数式はLaTeXや特殊記号は禁止。通常のテキスト表記で書くこと。
- 例: x^2+3x-4=0, 1/2, sqrt(3), a/b
- 分数は ( ) と / 、累乗は ^ 、絶対値は |x| 、根号は sqrt() で表現。
- 「\\frac」「\\sqrt」「^{ }」「_{ }」「\\( \\)」「$$」などは禁止。
`;

// 画像→要点抽出（data:URLで安定）
async function oaiVisionKeypoints(imageDataUrl) {
  const prompt = `あなたは塾講師のくまお先生。画像の問題文を読み取り、
1) 問題の種類/分野
2) 与条件（記号や定数）
3) 求めるもの
4) 重要な式・図の読み取り
を日本語で簡潔に、箇条書き3-6行で要点化してください。
${NO_LATEX_RULES}`;
  return await oaiChat({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } } // data:URL
      ],
    }],
    temperature: 0.2,
  });
}
async function simpleOaiText(prompt, temperature = 0.2) {
  return await oaiChat({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature });
}
async function oaiHint1(parseText) {
  const p = `あなたはくまお先生。次の要点から、最初の一歩のヒントを1-2行で示してください。
- 前提確認と入口の置き方だけ。式は最小限。
${NO_LATEX_RULES}
要点:
${parseText}`;
  return await simpleOaiText(p, 0.2);
}
async function oaiHint2(parseText) {
  const p = `あなたはくまお先生。次の要点から、二歩目のヒントを1-3行で示してください。
- 解法を確定させる決め手を短く。
${NO_LATEX_RULES}
要点:
${parseText}`;
  return await simpleOaiText(p, 0.2);
}
async function oaiSolution(parseText) {
  const p = `あなたはくまお先生。次の問題を段階的に解説してください。
- 見出し1行 → ステップ箇条書き(4-7) → 最後にワンポイント注意
- 各ステップは1-2文、長文禁止
${NO_LATEX_RULES}
要点:
${parseText}`;
  return await simpleOaiText(p, 0.3);
}
async function oaiCheckAnswer(parseText, userAnswer) {
  const p = `要点:
${parseText}

学習者の回答: ${userAnswer}

判定: 「CORRECT」または「WRONG」だけを出力。${NO_LATEX_RULES}`;
  const out = await simpleOaiText(p, 0);
  return /CORRECT/i.test(out);
}
async function oaiMicroReteach(parseText, userAnswer) {
  const p = `要点:
${parseText}

学習者の回答: ${userAnswer}

どこで躓いたかを1点だけ指摘→修正のコツを2行で。式は最小限。
${NO_LATEX_RULES}`;
  return await simpleOaiText(p, 0.3);
}
async function oaiOneShotExplain(text) {
  const p = `あなたはくまお先生。次の質問を一発でわかりやすく解説し、最後に次の一手を1行で提案してください。
${NO_LATEX_RULES}
質問:
${text}`;
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
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get("/", (_req, res) => res.status(200).send("kumao-vision-bot up"));
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.post("/webhook", async (req, res) => {
  try {
    if (VERIFY_SIGNATURE !== "false") {
      const signature = req.headers["x-line-signature"];
      const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
      if (hash !== signature) {
        console.warn("Signature mismatch");
        return res.status(403).send("forbidden");
      }
    }
    // 即ACK（LINEの3秒制限対策）
    res.status(200).end();

    const events = req.body?.events || [];
    for (const ev of events) handleEvent(ev).catch((e) => console.error("handleEvent error:", e));
  } catch (e) {
    console.error("webhook error:", e);
    try { res.status(200).end(); } catch {}
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  const message = event.message;

  let s = await getSession(userId);

  try {
    if (message.type === "image") {
      // 画像バイナリ取得 → data:URL でOpenAIへ
      const contentRes = await fetch(`${LINE_API_BASE}/message/${message.id}/content`, {
        headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` }
      });
      if (!contentRes.ok) throw new Error("getContent failed: " + await safeText(contentRes));
      const ab = await contentRes.arrayBuffer();
      const buf = Buffer.from(ab);
      const base64 = buf.toString("base64");
      const ctype = contentRes.headers.get("content-type") || "image/jpeg";
      const dataUrl = `data:${ctype};base64,${base64}`;

      s = reduceState(s, "IMAGE", { image: dataUrl }); await setSession(userId, s);

      const parse = await oaiVisionKeypoints(dataUrl);
      s = reduceState(s, "PARSE_DONE", { parse }); await setSession(userId, s);

      await linePush(userId, [
        ...textMsgs("まずは読み取った要点からいこっか。"),
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
          await linePush(userId, [...textMsgs(t1), ...textMsgs("よし、この流れで次いこう。準備できたらOKって送ってね")]);
          return;
        }
      } else if (isNo(text)) {
        s = reduceState(s, "NO"); await setSession(userId, s);
        await linePush(userId, textMsgs("よし、ここで直そ。どの部分が違いそう？（条件／図形／式）"));
        return;
      }

      // 進行キーワード
      if (/^(ok|オッケー|続け|つづけ|次|next)$/i.test(text)) {
        s = reduceState(s, "CONTINUE"); await setSession(userId, s);
        if (s.state === "HINT2") {
          const t2 = await oaiHint2(s.payload.parse);
          await linePush(userId, [...textMsgs(t2), ...textMsgs("いい感じ。続けてOK？")]);
          return;
        }
        if (s.state === "SOLUTION") {
          const sol = await oaiSolution(s.payload.parse);
          const chunks = chunkText(sol);
          await linePush(userId, [
            ...textMsgs(chunks),
            ...textMsgs("いったんここで区切るね。続きいこう🧸"),
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
          await linePush(userId, [...textMsgs(pick(TEMPLATES.praise)), ...textMsgs("別解も見てみる？")]);
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
    try { await linePush(userId, textMsgs("内部でエラーがあったよ…ちょっと待っててね🧸")); } catch {}
  }
}

function formatKeypoints(k) {
  const t = (k && (k.includes("・") || k.includes("-"))) ? k : "・" + (k || "").replace(/\n/g, "\n・");
  return `要点まとめ🧸\n${t}`.slice(0, 4000);
}

// ====== Start ======
app.listen(PORT, () => { console.log(`kumao-vision-bot listening on :${PORT}`); });
