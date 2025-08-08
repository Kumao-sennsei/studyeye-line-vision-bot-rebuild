// index.js くまお先生ボット “貼るだけ完全版”
// Railway/Express + LINE Messaging API + OpenAI（画像→段階対話、テキスト→一発解説）
// 署名検証ON/OFF、即時ACK→追送(返信/プッシュ)分割送信、自然会話テンプレ、軽量状態管理(メモリ/Redis)

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

// ====== ENV ======
const {
  PORT = 3000,
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  VERIFY_SIGNATURE = "true",
  REDIS_URL, // optional (eg. Upstash: rediss://:pass@host:port)
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("LINE環境変数が未設定です: LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY が未設定です");
  process.exit(1);
}

// ====== Minimal Redis Client (optional) ======
let redis = null;
if (REDIS_URL) {
  const { createClient } = await import("redis");
  redis = createClient({ url: REDIS_URL, socket: { tls: REDIS_URL.startsWith("rediss://") } });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();
  console.log("Redis connected");
}

// ====== State (session) ======
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isYes = (t) => /^(はい|ok|オッケー|おけ|了解|だいじょうぶ|大丈夫|いいよ|つづけ|続け|うん)/i.test((t||"").trim());
const isNo  = (t) => /^(いいえ|いや|ちがう|違う|待って|まって|ストップ|一回止め)/i.test((t||"").trim());
const looksLikeAnswer = (t) => /[0-9a-zA-Zぁ-んァ-ヶ一-龥=+\-*/^()π√％]/.test(t || "");
const chunkText = (text, size = 900) => { // LINEは最大1000字/件目安、余裕を持って
  const out = [];
  let rest = text;
  while (rest.length > size) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest) out.push(rest);
  return out;
};

// ====== Persona / Templates ======
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
  const body = { replyToken, messages };
  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("lineReply error:", res.status, t);
  }
}
async function linePush(to, messages) {
  const body = { to, messages };
  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("linePush error:", res.status, t);
  }
}
function lineTextMessages(textOrArray) {
  const arr = Array.isArray(textOrArray) ? textOrArray : [textOrArray];
  return arr.map((t) => ({ type: "text", text: t }));
}

// ====== OpenAI (Vision + Text) ======
async function oaiVisionKeypoints(imageUrlOrData) {
  // 画像→要点抽出（短め・箇条書き）
  const prompt = `
あなたは塾講師のくまお先生。画像の問題文を読み取り、
1) 問題の種類/分野
2) 与条件（記号や定数含む）
3) 求めるもの
4) 重要な式・図の読み取り
を日本語で簡潔に、箇条書き3-6行で要点化してください。`;

  const payload = {
    model: "gpt-4o-mini", // 画像入力対応の軽量モデル想定
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          (typeof imageUrlOrData === "string"
            ? { type: "image_url", image_url: { url: imageUrlOrData } }
            : { type: "input_image", image: imageUrlOrData }) // Base64等に対応
        ]
      }
    ],
    temperature: 0.2,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "要点抽出に失敗しました。もう一度画像を送ってください。";
  return text;
}

async function oaiHint1(parseText) {
  const prompt = `
あなたはくまお先生。次の問題要点から、最初の一歩のヒントを1-2行で出して。
- 前提の確認と入口の置き方だけ。式は最小限。
要点:
${parseText}`;
  return await simpleOaiText(prompt, 0.2);
}
async function oaiHint2(parseText) {
  const prompt = `
あなたはくまお先生。次の問題要点から、二歩目のヒントを1-3行で。
- 解法を確定させる決定打を短く。式は簡潔に。
要点:
${parseText}`;
  return await simpleOaiText(prompt, 0.2);
}
async function oaiSolution(parseText) {
  const prompt = `
あなたはくまお先生。次の問題を段階的に解説。
- 見出し1行 → ステップを短文箇条書き(4-7項目) → 最後にワンポイント注意
- 各ステップは1-2文、長文禁止
- 数式は簡潔に
要点:
${parseText}`;
  return await simpleOaiText(prompt, 0.3);
}
async function oaiCheckAnswer(parseText, userAnswer) {
  const prompt = `
要点:
${parseText}

学習者の回答: ${userAnswer}

判定: 「CORRECT」または「WRONG」だけを出力。
`;
  const out = await simpleOaiText(prompt, 0);
  return /CORRECT/i.test(out);
}
async function oaiMicroReteach(parseText, userAnswer) {
  const prompt = `
要点:
${parseText}

学習者の回答: ${userAnswer}

どこで躓いたかを1点だけ指摘→修正のコツを2行で。式は最小限。
`;
  return await simpleOaiText(prompt, 0.3);
}
async function oaiOneShotExplain(text) {
  const prompt = `
あなたはくまお先生。次の質問を一発でわかりやすく解説し、最後に次の一手を1行で提案。
質問:
${text}`;
  const out = await simpleOaiText(prompt, 0.3);
  const parts = out.split("\n").filter(Boolean);
  const summary = parts.slice(0, -1).join("\n") || out;
  const nextStep = parts.slice(-1)[0] || "他にも気になる点があれば送ってね！";
  return { summary, nextStep };
}

async function simpleOaiText(prompt, temperature = 0.2) {
  const payload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature,
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "うまく説明できなかった…もう一度だけ質問文を送ってくれる？";
}

// ====== Minimal State Machine ======
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

// ====== Express Setup ======
const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

// Health
app.get("/", (req, res) => res.status(200).send("kumao-vision-bot up"));
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

// Webhook
app.post("/webhook", async (req, res) => {
  // Signature verify (optional)
  if (VERIFY_SIGNATURE !== "false") {
    const signature = req.headers["x-line-signature"];
    const hash = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET)
      .update(req.rawBody)
      .digest("base64");
    if (hash !== signature) {
      console.warn("Signature mismatch");
      return res.status(403).send("forbidden");
    }
  }

  // すぐACK（LINEのタイムアウト対策）
  res.status(200).end();

  const body = req.body;
  const events = body?.events || [];
  for (const ev of events) {
    handleEvent(ev).catch((e) => console.error("handleEvent error:", e));
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const message = event.message;

  // 初期セーフ返信（空打ち防止）
  await lineReply(replyToken, lineTextMessages("うけとったよ🧸 ちょっとだけ考えさせてね…"));

  let s = await getSession(userId);

  try {
    if (message.type === "image") {
      // 画像コンテンツURLは本来getContentで取得、ここでは簡易にメッセージID URLを使わず、ユーザにURL画像送信前提 or LINE getContent実装例を入れる
      // 実運用：/v2/bot/message/{messageId}/content を叩いてBuffer→Base64
      const imgBuf = await fetch(`${LINE_API_BASE}/message/${message.id}/content`, {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
      }).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error("getContent failed")));
      const base64 = Buffer.from(imgBuf).toString("base64");

      s = reduceState(s, "IMAGE", { image: base64 });
      await setSession(userId, s);

      const parse = await oaiVisionKeypoints(base64);
      s = reduceState(s, "PARSE_DONE", { parse });
      await setSession(userId, s);

      // 要点→人間チェック
      const msgs = [
        ...lineTextMessages(formatKeypoints(parse)),
        ...lineTextMessages(pick(TEMPLATES.confirm_steps)),
      ];
      await linePush(userId, msgs);
      return;
    }

    if (message.type === "text") {
      const text = (message.text || "").trim();

      // YES/NO
      if (isYes(text)) {
        s = reduceState(s, "YES");
        await setSession(userId, s);
        if (s.state === "HINT1") {
          const t1 = await oaiHint1(s.payload.parse);
          await linePush(userId, [
            ...lineTextMessages(t1),
            ...lineTextMessages("続けようか？（OKで進むよ）")
          ]);
          return;
        }
      } else if (isNo(text)) {
        s = reduceState(s, "NO");
        await setSession(userId, s);
        await linePush(userId, lineTextMessages("よし修正するね。どの部分が違いそう？（条件／図形／式）"));
        return;
      }

      // 進行キーワード
      if (/^(ok|オッケー|続け|つづけ|次|next)$/i.test(text)) {
        s = reduceState(s, "CONTINUE");
        await setSession(userId, s);
        if (s.state === "HINT2") {
          const t2 = await oaiHint2(s.payload.parse);
          await linePush(userId, [
            ...lineTextMessages(t2),
            ...lineTextMessages("もう一歩いこう。OKなら続けるよ")
          ]);
          return;
        }
        if (s.state === "SOLUTION") {
          const sol = await oaiSolution(s.payload.parse);
          const chunks = chunkText(sol);
          const msgs = [
            ...lineTextMessages(chunks[0] || ""),
            ...(chunks.slice(1).map((c) => ({ type: "text", text: c }))),
            ...lineTextMessages("ここで区切るね🐾"),
            ...lineTextMessages(pick(TEMPLATES.ask_try_alone)),
          ];
          await linePush(userId, msgs);
          s = reduceState(s, "ASK_TRY");
          await setSession(userId, s);
          return;
        }
      }

      // 自力回答
      if (looksLikeAnswer(text)) {
        s = reduceState(s, "ANSWER", { answer: text });
        await setSession(userId, s);

        // まだ画像ルート通ってない時は一発解説へ
        if (!s.payload?.parse) {
          const { summary, nextStep } = await oaiOneShotExplain(text);
          await linePush(userId, [
            ...lineTextMessages(chunkText(summary)),
            ...lineTextMessages(nextStep),
          ]);
          s = reduceState(s, "START");
          await setSession(userId, s);
          return;
        }

        const ok = await oaiCheckAnswer(s.payload.parse, text);
        s = reduceState(s, ok ? "CORRECT" : "WRONG");
        await setSession(userId, s);

        if (s.state === "PRAISE") {
          await linePush(userId, [
            ...lineTextMessages(pick(TEMPLATES.praise)),
            ...lineTextMessages("仕上げに別解も見てみる？")
          ]);
          await clearSession(userId);
          return;
        }
        if (s.state === "RETEACH") {
          const micro = await oaiMicroReteach(s.payload.parse, text);
          await linePush(userId, [
            ...lineTextMessages(pick(TEMPLATES.near_miss)),
            ...lineTextMessages(micro),
          ]);
          // 状態はTRY_ALONEに戻す
          s = { state: "TRY_ALONE", payload: s.payload };
          await setSession(userId, s);
          return;
        }
      }

      // テキスト一発解説の入口（画像なし）
      if (true) {
        const { summary, nextStep } = await oaiOneShotExplain(text);
        await linePush(userId, [
          ...lineTextMessages(chunkText(summary)),
          ...lineTextMessages(nextStep),
        ]);
        await clearSession(userId);
        return;
      }
    }
  } catch (err) {
    console.error("handleEvent inner error:", err);
    await linePush(userId, lineTextMessages("内部でエラーがあったよ…ちょっと待っててね🧸"));
  }
}

function formatKeypoints(k) {
  // 箇条書きが来る想定。なければ整形
  const t = k.includes("・") || k.includes("-") ? k : "・" + k.replace(/\n/g, "\n・");
  return `要点まとめ🧸\n${t}`.slice(0, 4000);
}

// ====== Start ======
app.listen(PORT, () => {
  console.log(`kumao-vision-bot listening on :${PORT}`);
});
