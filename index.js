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
const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

/* =====================
   ユーザー状態
===================== */
const userState = {};

/* =====================
   プロンプト（JS安全）
===================== */

const BASE_RULE_PROMPT = `
あなたは「くまお先生」。とてもやさしく明るく、生徒に寄り添うスーパー先生🐻✨

【表記ルール（必ず守る）】
・LINE上で読みやすい文章のみ
・Markdown記法は禁止（**、__、##、---、=== など使わない）
・LaTeX記法は禁止（\\frac、\\[ \\] など使わない）
・仕切り線（--- や ――）は使わない
・√、√2、10²³ の表記は使用OK
・分数は a/b の形で書く

【テンプレ厳守】
・必ず最初の1行目は次の文言に固定：
「くまお先生です！やさしく解説するね🐻✨」

・解き方の手順は必ず 1⃣ 2⃣ 3⃣
（①②③は共通テストの選択肢と混同するので使わない）
`;

const QUESTION_TEMPLATE_PROMPT = `
くまお先生です！やさしく解説するね🐻✨

【問題の要点】

【解き方】
1⃣
2⃣
3⃣

【解説】

【答え】
・単語や数値は必ずはっきり書く
・記述問題の場合は正答例を1つ示す

ほかに聞きたい？
それともこの問題の類題を解いてみる？
`;

const QUESTION_SYSTEM_PROMPT = BASE_RULE_PROMPT + QUESTION_TEMPLATE_PROMPT;

const VISION_RULE_PROMPT = `
【画像問題のルール】
・画像内の文章／条件／構造式／選択肢番号を丁寧に読み取る
・共通テストなど選択肢問題の場合：
　【答え】は必ず「①〜⑥」のいずれかで出す
・公式の答え（正答番号や正答）が与えられた場合：
　その答えを正解として扱い、解説を必ずその答えに合わせる
　（もし自分の推定とズレても、公式の答えを優先）
・不鮮明で確信が持てない場合：
　当てずっぽうで断定せず、「選択肢の番号が読みにくい」など短く正直に述べる
`;

const VISION_SYSTEM_PROMPT =
  BASE_RULE_PROMPT + VISION_RULE_PROMPT + QUESTION_TEMPLATE_PROMPT;

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
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (e) {
      console.error(e);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* 画像 */
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "waiting_official_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n" +
        "この問題の公式の答え（例：①、⑥、または答えの語句）が分かれば送ってね。\n" +
        "分からなければ「答えなし」でOKだよ😊",
    });
  }

  /* テキスト */
  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* 画像の答え待ち */
  if (userState[userId]?.mode === "waiting_official_answer") {
    const imageId = userState[userId].imageId;

    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    userState[userId] = { mode: "after_question" };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });
  }

  /* メニュー選択：今の仕様どおり（①のみ運用中ならここだけでもOK） */
  if (text === "①" || text === "質問がしたい" || text.includes("質問")) {
    userState[userId] = { mode: "question_text" };
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "質問モードだよ🐻✨\n" +
        "文章でも、問題の写真でも送ってOKだよ😊",
    });
  }

  /* 質問（文章） */
  if (userState[userId]?.mode === "question_text") {
    const result = await runTextQuestionMode(text);
    userState[userId] = { mode: "after_question" };
    return client.replyMessage(event.replyToken, { type: "text", text: result });
  }

  return replyMenu(event.replyToken);
}

/* =====================
   OpenAI 呼び出し
===================== */
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages,
    }),
  });

  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "ごめんね、うまく返せなかったよ🐻💦";
}

/* =====================
   質問モード（文章）
===================== */
async function runTextQuestionMode(text) {
  return callOpenAI([
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: text },
  ]);
}

/* =====================
   Vision質問（画像）
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const officialText = officialAnswer
    ? `公式の答え（正答）は「${officialAnswer}」です。この答えを正解として解説してください。`
    : "公式の答えは不明です。画像から読み取って解いてください。";

  return callOpenAI([
    { role: "system", content: VISION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: officialText },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

/* =====================
   画像取得
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

/* =====================
   メニュー
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n" +
      "① 質問がしたい😊\n" +
      "② 講義を受けたい📘\n" +
      "③ 演習（類題）をしたい✏️\n" +
      "④ 雑談がしたい💬",
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ 起動しました");
});
