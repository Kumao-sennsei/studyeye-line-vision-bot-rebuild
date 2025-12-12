// index.js（質問モード 完全版：文章＋画像 / 禁止記号フィルター / 内部計算と表示分離 / 類題導線つき）
// ※このファイルをまるごと置き換えでOK

import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Client } from "@line/bot-sdk";

const app = express();

/* =====================
  環境変数
===================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* =====================
  LINE クライアント
===================== */
const client = new Client({ channelAccessToken: CHANNEL_ACCESS_TOKEN });

/* =====================
  ユーザー状態（メモリ）
  ※Railway再起動で消えます（本番はDB推奨）
===================== */
/*
state[userId] = {
  mode: "idle" | "question_text" | "waiting_official_answer" | "after_answer" | "exercise_stub",
  last: { type: "text"|"image", text?: string, imageId?: string },
  pendingImageId?: string,
}
*/
const state = {};

/* =====================
  Webhook
===================== */
app.post(
  "/webhook",
  express.json({
    verify: (req, res, buf) => {
      const signature = crypto
        .createHmac("SHA256", CHANNEL_SECRET)
        .update(buf)
        .digest("base64");

      if (signature !== req.headers["x-line-signature"]) {
        throw new Error("Invalid signature");
      }
    },
  }),
  async (req, res) => {
    try {
      await Promise.all((req.body?.events || []).map(handleEvent));
      res.status(200).end(); // LINEへは必ず200
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end(); // LINEへは必ず200
    }
  }
);

/* =====================
  メイン
===================== */
async function handleEvent(event) {
  try {
    if (!event) return;
    if (event.type !== "message") return;

    const userId = event.source?.userId;
    if (!userId) return;

    // 状態初期化
    if (!state[userId]) state[userId] = { mode: "idle", last: null, pendingImageId: null };

    // ---------- 画像 ----------
    if (event.message?.type === "image") {
      return onImageMessage(event, userId);
    }

    // ---------- テキスト ----------
    if (event.message?.type === "text") {
      return onTextMessage(event, userId, event.message.text.trim());
    }

    // 他は無視
    return;
  } catch (err) {
    console.error("handleEvent error:", err);
    // 返信トークンがあれば一応返す（ただし失敗しても落とさない）
    try {
      if (event?.replyToken) {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: "ごめん、ちょっとエラーが出たみたい🙏 もう一度送ってみて！",
        });
      }
    } catch (_) {}
  }
}

/* =====================
  画像受信
  画像→公式答え待ちへ
===================== */
async function onImageMessage(event, userId) {
  // 画像ID保存、公式答え待ちへ
  state[userId].mode = "waiting_official_answer";
  state[userId].pendingImageId = event.message.id;
  state[userId].last = { type: "image", imageId: event.message.id };

  // ※ここに ** を入れない（禁止）
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "画像を受け取ったよ🐻✨\n\n" +
      "この問題の「公式の答え」（問題集・プリント付属の答え）を送ってね。\n\n" +
      "・答えだけでもOK\n" +
      "・手元にないなら「答えなし」と送ってね\n\n" +
      "答えが来たら、それを基準に解説するよ🔥",
  });
}

/* =====================
  テキスト受信
===================== */
async function onTextMessage(event, userId, text) {
  // ① 挨拶・メニュー
  if (isGreeting(text)) {
    state[userId].mode = "idle";
    state[userId].pendingImageId = null;
    return replyMenu(event.replyToken);
  }

  // ② 「質問」入口（質問モード固定運用）
  if (isQuestionEntry(text)) {
    state[userId].mode = "question_text";
    state[userId].pendingImageId = null;
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "OK！質問モードだよ🐻✨\n\n" +
        "・文章でそのまま送ってOK\n" +
        "・画像で送ってOK（画像のあとに公式の答えを送ってね）\n\n" +
        "さあ、どうぞ！",
    });
  }

  // ③ 公式答え待ち（画像のあと）
  if (state[userId].mode === "waiting_official_answer") {
    const imageId = state[userId].pendingImageId;
    state[userId].pendingImageId = null;

    // 画像がないのに待ち状態はおかしいので保険
    if (!imageId) {
      state[userId].mode = "question_text";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ごめん、画像が見当たらなかった🙏 もう一度画像を送ってね！",
      });
    }

    const officialAnswer = normalizeOfficialAnswer(text); // nullなら答えなし扱い

    // ここで Vision 解析 → 内部計算 → 表示整形
    try {
      const base64 = await getImageBase64(imageId);

      // 内部計算（正確さ優先）
      const internal = await solveFromImageInternal(base64, officialAnswer);

      // 表示整形（見栄え・板書）
      const display = await formatForDisplay(internal, "image");

      // 禁止記号フィルター（最終安全弁）
      const safe = sanitizeText(display);

      await replyLongText(event.replyToken, userId, safe);

      // 返答後の導線
      state[userId].mode = "after_answer";
      return followUpAfterAnswer(userId);
    } catch (err) {
      console.error("Vision flow error:", err);
      state[userId].mode = "question_text";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "ごめん、画像の処理でエラーが出ちゃった🙏\n" +
          "もう一度、画像→（公式の答え or 答えなし）を送ってみて！",
      });
    }
  }

  // ④ 解説後のフォロー
  if (state[userId].mode === "after_answer") {
    // 類題へ
    if (isRuijdai(text)) {
      state[userId].mode = "exercise_stub";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！類題に行こう🐻🔥\n\n" +
          "今は「質問モード完成」優先で、演習モードは次で仕上げるよ。\n" +
          "とりあえず今は、もう1問ほしい？それとも別の質問にする？\n\n" +
          "・もう1問\n" +
          "・別の質問",
      });
    }

    // 他の質問へ
    if (isOtherQuestion(text)) {
      state[userId].mode = "question_text";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "OK！続けて質問どうぞ🐻✨ 文章でも画像でもOKだよ！",
      });
    }

    // 「ありがとう」など
    if (isThanks(text)) {
      // ありがとうのあとも自然に誘導（質問モード継続）
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "いいよ🐻✨\n" +
          "ほかに聞きたいことはある？それともこの問題の類題を解いてみる？\n\n" +
          "・ほかに聞きたい\n" +
          "・類題",
      });
    }

    // どっちでもない場合は、質問として扱って継続（便利）
    state[userId].mode = "question_text";
    return answerTextQuestion(event, userId, text);
  }

  // ⑤ 演習スタブ中（今は案内だけ）
  if (state[userId].mode === "exercise_stub") {
    if (text.includes("別の質問")) {
      state[userId].mode = "question_text";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "了解！別の質問どうぞ🐻✨",
      });
    }
    if (text.includes("もう1問")) {
      // 本格演習は次だが、簡易類題生成だけは可能
      return generateQuickSimilarProblem(event, userId);
    }

    // デフォルト：質問に戻す
    state[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "OK！じゃあ質問に戻ろう🐻✨ 文章でも画像でも送ってね！",
    });
  }

  // ⑥ 質問モード（文章）
  if (state[userId].mode === "question_text") {
    return answerTextQuestion(event, userId, text);
  }

  // ⑦ どこにも当てはまらない → メニュー
  return replyMenu(event.replyToken);
}

/* =====================
  文章質問：回答
  内部計算→表示整形→フィルター
===================== */
async function answerTextQuestion(event, userId, text) {
  state[userId].last = { type: "text", text };

  try {
    // 内部計算（難易度でモデル切替）
    const internal = await solveFromTextInternal(text);

    // 表示整形
    const display = await formatForDisplay(internal, "text");

    // 禁止記号フィルター
    const safe = sanitizeText(display);

    await replyLongText(event.replyToken, userId, safe);

    state[userId].mode = "after_answer";
    return followUpAfterAnswer(userId);
  } catch (err) {
    console.error("Text question error:", err);
    state[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "ごめん、作成中にエラーが出た🙏\n" +
        "もう一度そのまま送ってくれる？",
    });
  }
}

/* =====================
  解説後フォロー（pushでも可）
===================== */
async function followUpAfterAnswer(userId) {
  // replyMessage の直後に push すると失敗する環境があるので、ここは push を使う
  try {
    await client.pushMessage(userId, {
      type: "text",
      text:
        "ほかに聞きたいことはある？それともこの問題の類題を解いてみる？\n\n" +
        "・ほかに聞きたい\n" +
        "・類題",
    });
  } catch (err) {
    // pushが無理でも致命的ではない
    console.error("followUp push error:", err);
  }
}

/* =====================
  メニュー
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "（講義・演習は準備中だよ）\n\n" +
      "「①」か「質問」って送ってね！",
  });
}

/* =====================
  内部計算：テキスト（モデル自動切替）
  返すのは “解くための材料” （表示ではない）
===================== */
async function solveFromTextInternal(questionText) {
  const model = chooseTextModel(questionText);

  const system = `
あなたは数学・理科の解答作成エンジン。
目的は「正確に解く」こと。表示の文章は不要。

出力は必ず次のJSONだけ（説明文なし、改行ありOK）。
キーはこの4つだけ。

{
  "gist": "何が問われているかを短く",
  "plan": ["手順1", "手順2", "手順3"],
  "work": ["途中式や計算の要点を箇条書き（短く）"],
  "answer": "最終答案（式や数値）"
}

注意：
・Markdown記号（*, _, ~, `）は絶対に使わない
・LaTeX（\\( \\), \\[ \\], $）は使わない
・数式は普通の文字でOK（例：x^2、(a+b)、20/3、-2、×、+、-）
・分数は a/b の形でOK
`;

  const user = `
問題：
${questionText}

正確に解いて、指定JSONで出して。
`;

  const raw = await callOpenAI({
    model,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() },
    ],
  });

  const cleaned = sanitizeText(raw);
  const parsed = safeParseJSON(cleaned);

  // 保険：JSON壊れてたらそのまま包む
  if (!parsed) {
    return {
      gist: "問題の要点を整理して解く",
      plan: ["条件を整理する", "必要な式や考え方を選ぶ", "計算して答えを出す"],
      work: [cleaned.slice(0, 900)],
      answer: "（答え生成に失敗）",
    };
  }
  return parsed;
}

/* =====================
  内部計算：画像（gpt-4.1固定）
===================== */
async function solveFromImageInternal(imageBase64, officialAnswer) {
  const system = `
あなたは画像の問題を正確に解くエンジン。
目的は「正確に解く」こと。表示の文章は不要。

出力は必ず次のJSONだけ（説明文なし）。
キーはこの4つだけ。

{
  "gist": "何が問われているかを短く",
  "plan": ["手順1", "手順2", "手順3"],
  "work": ["途中式や計算の要点を箇条書き（短く）"],
  "answer": "最終答案（式や数値）"
}

注意：
・Markdown記号（*, _, ~, `）は絶対に使わない
・LaTeX（\\( \\), \\[ \\], $）は使わない
・数式は普通の文字でOK（例：x^2、(a+b)、20/3、-2、×、+、-）
・分数は a/b の形でOK
・公式の答えが与えられた場合：答えはそれに合わせる（途中の整合を取る）
`;

  const userText = officialAnswer
    ? `この問題の公式の答え（問題集やプリント付属の答え）は「${officialAnswer}」。これを基準に整合を取って解いて。`
    : "公式の答えはなし。問題を読み取って解いて。";

  const raw = await callOpenAI({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: system.trim() },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      },
    ],
  });

  const cleaned = sanitizeText(raw);
  const parsed = safeParseJSON(cleaned);

  if (!parsed) {
    return {
      gist: "画像の問題を読み取り、求める値を出す",
      plan: ["条件を整理する", "必要な式や考え方を選ぶ", "計算して答えを出す"],
      work: [cleaned.slice(0, 900)],
      answer: officialAnswer || "（答え生成に失敗）",
    };
  }
  return parsed;
}

/* =====================
  表示整形（板書スタイル）
  入力：内部JSON
  出力：見せる文章
===================== */
async function formatForDisplay(internalJSON, sourceType) {
  const system = `
あなたは「くまお先生」。
明るく優しく、中高生に寄り添う口調で、板書みたいに整える。

書式ルール（必須）：
・Markdown の記号（*, **, _, __, ~~）は禁止
・LaTeX の記号（\\(\\)、\\[\\]、$）は禁止
・太字、斜体、強調、コードブロック、表は禁止
・使ってよい装飾は「・」と、番号の 1⃣ 2⃣ 3⃣ 4⃣ 5⃣ のみ
・数式は普通の文字でOK（例：x^2、20/3、-2、×、+、-）
・なるべく見やすく改行する

必ずこの順番で出す：
【問題の要点】（短く。絵文字OK）
【解き方】
  1⃣ …
  2⃣ …
  3⃣ …（必要なら4⃣5⃣）
  最後に一言「この流れで解けそうなら、自分でもやってみよっか🐻✨」
【解説】（先生が黒板で説明するように。短めで、今なにしてるか分かる）
【答え】（1行で）

最後は必ず：
このページ、ノートに写しておくと復習しやすいよ🐻✨
`;

  const user = `
これは内部計算の結果（JSON）です。これを上の形式に整えて出力して。

入力JSON：
${JSON.stringify(internalJSON, null, 2)}

補足：
・sourceType=${sourceType}
・余計な前置き（ありがとう等）は不要
`;

  const raw = await callOpenAI({
    model: "gpt-4o", // 表示整形は4oで十分（安定）
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user.trim() },
    ],
  });

  return raw;
}

/* =====================
  類題：簡易生成（質問モード内の軽いサービス）
===================== */
async function generateQuickSimilarProblem(event, userId) {
  const last = state[userId]?.last;

  // lastが無いなら質問に戻す
  if (!last) {
    state[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "OK！まずは何か質問を送ってね🐻✨（文章でも画像でもOK）",
    });
  }

  try {
    const system = `
あなたは「くまお先生」。
類題を1問だけ作る。解答や解説は出さない。

ルール：
・Markdown記号（*, _, ~, `）禁止
・LaTeX禁止
・問題文は短く
・最後に「答えが分かったら送ってね🐻✨」を付ける
`;

    const user = last.type === "text"
      ? `この問題に近い類題を1問作って。\n元の問題：\n${last.text}`
      : `この画像の問題に近い類題を1問作って（文章で）。元の問題は画像だよ。`;

    const raw = await callOpenAI({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
    });

    const safe = sanitizeText(raw);
    state[userId].mode = "question_text"; // 類題は質問として続ける（答え送らせる）
    return client.replyMessage(event.replyToken, { type: "text", text: safe });
  } catch (err) {
    console.error("similar problem error:", err);
    state[userId].mode = "question_text";
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ごめん、類題づくりでエラーが出た🙏 いったん質問に戻ろう！",
    });
  }
}

/* =====================
  OpenAI 呼び出し（共通）
===================== */
async function callOpenAI({ model, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("OpenAI error:", t);
    throw new Error("OpenAI request failed");
  }

  const json = await res.json();
  return json?.choices?.[0]?.message?.content || "";
}

/* =====================
  LINE画像 → base64
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("LINE image fetch error:", t);
    throw new Error("LINE image fetch failed");
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

/* =====================
  返信：長文分割
  replyは最大5件 → 余りはpush
===================== */
async function replyLongText(replyToken, userId, text) {
  const chunks = chunkText(text, 950); // 安全寄り
  const first = chunks.slice(0, 5);

  await client.replyMessage(
    replyToken,
    first.map((t) => ({ type: "text", text: t }))
  );

  const rest = chunks.slice(5);
  for (const r of rest) {
    try {
      await client.pushMessage(userId, { type: "text", text: r });
    } catch (err) {
      console.error("push rest chunk error:", err);
      break;
    }
  }
}

function chunkText(text, maxLen) {
  const out = [];
  let t = (text || "").trim();

  while (t.length > maxLen) {
    // なるべく改行で切る
    let cut = t.lastIndexOf("\n", maxLen);
    if (cut < 200) cut = maxLen;
    out.push(t.slice(0, cut).trim());
    t = t.slice(cut).trim();
  }
  if (t.length) out.push(t);
  return out;
}

/* =====================
  禁止記号フィルター（最終安全弁）
  ※数学の × + - / ^ は残す
===================== */
function sanitizeText(input) {
  if (!input) return "";

  let t = String(input);

  // Markdown系（強調など）
  t = t.replace(/\*\*/g, "");      // **
  t = t.replace(/__/g, "");        // __
  t = t.replace(/\*/g, "");        // *
  t = t.replace(/~~/g, "");        // ~~
  t = t.replace(/`{1,3}/g, "");    // ` or ``` 

  // LaTeX区切り
  t = t.replace(/\\\(/g, "");
  t = t.replace(/\\\)/g, "");
  t = t.replace(/\\\[/g, "");
  t = t.replace(/\\\]/g, "");
  t = t.replace(/\$/g, "");

  // 変な見出し記号（#）は消して板書に寄せる
  t = t.replace(/^#+\s*/gm, "");

  // 余計な連続空白を少し整える
  t = t.replace(/[ \t]{2,}/g, " ");

  // 先頭末尾
  return t.trim();
}

/* =====================
  JSONパース（壊れた時はnull）
===================== */
function safeParseJSON(text) {
  try {
    const s = text.trim();

    // 余計な前後が混ざっても中のJSONだけ拾う
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;

    const jsonStr = s.slice(first, last + 1);
    const obj = JSON.parse(jsonStr);

    if (!obj || typeof obj !== "object") return null;
    if (!obj.gist || !obj.plan || !obj.work || !obj.answer) return null;

    // plan/work を配列に寄せる
    if (!Array.isArray(obj.plan)) obj.plan = [String(obj.plan)];
    if (!Array.isArray(obj.work)) obj.work = [String(obj.work)];

    return obj;
  } catch {
    return null;
  }
}

/* =====================
  モデル選択（テキスト）
===================== */
function chooseTextModel(text) {
  const t = (text || "").toLowerCase();

  // 最難関ワード
  const hardKeywords = ["東大", "京大", "医学部", "難関", "記述", "証明", "極限", "微分方程式", "線形代数", "複素数平面"];
  if (hardKeywords.some((k) => text.includes(k))) return "gpt-4.1";

  // 計算・数式っぽさで中難度
  const mediumSignals = ["∫", "積分", "微分", "log", "ln", "sin", "cos", "tan", "ベクトル", "確率", "漸化式", "行列"];
  if (mediumSignals.some((k) => text.includes(k))) return "gpt-4o";

  // 長文は4oへ
  if (text.length > 220) return "gpt-4o";

  // それ以外は軽量
  return "gpt-4o-mini";
}

/* =====================
  公式答え 正規化
===================== */
function normalizeOfficialAnswer(text) {
  const t = (text || "").trim();
  if (!t) return null;

  const no = ["答えなし", "なし", "わからない", "不明", "ない"];
  if (no.includes(t)) return null;

  // 答えだけでもOKなので、そのまま返す
  return t;
}

/* =====================
  入力判定
===================== */
function isGreeting(text) {
  const t = (text || "").trim();
  return ["こんにちは", "こんちは", "こんばんは", "おはよう", "はじめまして", "やあ"].includes(t);
}

function isQuestionEntry(text) {
  const t = (text || "").trim();
  return t === "①" || t === "1" || t === "質問" || t === "質問がしたい";
}

function isThanks(text) {
  const t = (text || "").trim();
  return ["ありがとう", "ありがと", "助かった", "サンキュー", "thx", "thanks", "感謝"].includes(t);
}

function isRuijdai(text) {
  const t = (text || "").trim();
  return t === "類題" || t === "るいだい" || t.includes("類題");
}

function isOtherQuestion(text) {
  const t = (text || "").trim();
  return t.includes("ほかに") || t.includes("他に") || t.includes("別の") || t === "ほかに聞きたい" || t === "別の質問";
}

/* =====================
  起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 質問モードBOT 起動！");
});
