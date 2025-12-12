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
   ユーザー状態保存
===================== */
// userState[userId] = { mode, subject, unit, waitingForAnswer }
const userState = {};

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
      res.status(200).end(); // ← LINE は必ず 200 応答
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end(); // ← ここも絶対 200
    }
  }
);
/* =====================
   質問モード（テキスト & 画像）
===================== */

async function handleEvent(event) {
  const userId = event.source.userId;

  // ---------- 画像 ----------
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "question_waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の **公式の答え（問題集やプリントの答え）** を送ってね！\n\n" +
        "もし手元にない場合は「答えなし」と送ってくれたら、\n" +
        "くまお先生が代わりに解くよ🔥",
    });
  }

  // ---------- テキスト ----------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* --- 公式の答え待ち --- */
    if (userState[userId]?.mode === "question_waiting_answer") {
      const imageId = userState[userId].imageId;
      userState[userId] = null;

      const officialAnswer =
        text === "答えなし" || text === "なし" ? null : text;

      try {
        const base64 = await getImageBase64(imageId);

        const explanation = await runVisionQuestionMode(
          base64,
          officialAnswer
        );

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: explanation,
        });
      } catch (err) {
        console.error("Vision question error:", err);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text:
            "画像の処理中にエラーが出ちゃった🙏\n" +
            "もう一度送ってくれる？",
        });
      }
    }

    /* --- 質問モードへ入る --- */
    if (text === "①" || text === "質問") {
      userState[userId] = { mode: "question_text" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "質問モードだよ🐻✨\n\n" +
          "・文章で質問\n" +
          "・画像で送る\n\n" +
          "どちらでもOKだよ！",
      });
    }

    /* --- 質問（文章） --- */
    if (userState[userId]?.mode === "question_text") {
      userState[userId] = null;

      const result = await runTextQuestionMode(text);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: result,
      });
    }
  }
}

/* =====================
   画像質問モード Vision
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」です。とても優しく、板書のように整理して教える先生です。
生徒は高校生〜中学生。

【必ず守る形式】

1. 【問題の要点】
 - 問題文を短く要約する

2. 【解き方】
 - ステップ1⃣
 - ステップ2⃣
 - ステップ3⃣（必要なら）

3. 【解説】
 - 初学者にもわかるように優しく丁寧に

4. 【答え】
 - 公式の答えがある場合 → それを基準に説明
 - 公式答えが無い場合 → あなたが解き、正答を書く

最後に：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  const messages = [
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            officialAnswer
              ? `この問題の公式の答えは「${officialAnswer}」です。これをもとに解説してください。`
              : "公式の答えはありません。問題を読み取り、解いてから説明してください。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  const data = await callOpenAI(messages);
  return data;
}

/* =====================
   質問（文章）GPT-4.1
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」。優しく明るく、中高生に寄り添って説明します。

【形式】
1. 【問題の要点】
2. 【解き方】（ステップ1→2→3）
3. 【解説】
4. 【答え】

最後に：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: text },
  ];

  const data = await callOpenAI(messages);
  return data;
}

/* =====================
   OpenAI 呼び出し（共通）
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
  return json.choices[0].message.content;
}

/* =====================
   LINE画像 → base64
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    }
  );

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}
/* ============================
   講義モード
============================ */
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 講義モード開始
    if (text === "②" || text === "講義") {
      userState[userId] = { mode: "lecture_subject" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "OK！講義モード📘✨\n" +
          "まずは教科を教えてね！（数学 / 物理 / 化学 / 英語 など）",
      });
    }

    // 教科入力待ち
    if (userState[userId]?.mode === "lecture_subject") {
      userState[userId] = {
        mode: "lecture_unit",
        subject: text,
      };

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `教科は「${text}」だね📘✨\n` +
          "次に、単元を教えてね！（例：2次関数、波動、酸化還元、英文法など）",
      });
    }

    // 単元入力 → 講義生成
    if (userState[userId]?.mode === "lecture_unit") {
      const subject = userState[userId].subject;
      const unit = text;

      userState[userId] = null;

      try {
        const lecture = await createLecture(subject, unit);
        const chunks = splitLongText(lecture, 1100);

        const messages = chunks.map((c) => ({
          type: "text",
          text: c,
        }));

        return client.replyMessage(event.replyToken, messages);
      } catch (e) {
        console.error("Lecture Error:", e);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text:
            "講義生成でちょっと問題が起きたみたい🙏\n" +
            "もう一度、教科から送ってみてね！",
        });
      }
    }
  }
}

/* ============================
   講義生成 OpenAI
============================ */
async function createLecture(subject, unit) {
  const system = `
あなたは優しく明るい「くまお先生」。
中高生向けに、板書のように段階的に講義を作ります。

【講義構成】
1. 導入
----
2. 基本の考え方
----
3. 具体例
----
4. よくあるつまずき
----
5. 今日のまとめ
`;

  const user = `教科: ${subject}\n単元: ${unit}\nこの内容で講義を作成。`;

  const result = await callOpenAI([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);

  return result;
}

/* ============================
   雑談モード
============================ */
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 雑談開始
    if (text === "④" || text === "雑談") {
      userState[userId] = { mode: "chat" };
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "雑談しよう〜☕🐻✨　なんでも話してね！",
      });
    }

    // 続きの雑談
    if (userState[userId]?.mode === "chat") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `なるほどなるほど🐻✨\n${text}、面白いね〜！もっと教えて〜！`,
      });
    }
  }
}

/* ============================
   メニュー送信
============================ */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習がしたい 📝（準備中）\n" +
      "④ 雑談したい ☕",
  });
}

/* ============================
   長文分割（LINE 1100字制限対策）
============================ */
function splitLongText(text, maxLen) {
  const out = [];
  let t = text;

  while (t.length > maxLen) {
    out.push(t.slice(0, maxLen));
    t = t.slice(maxLen);
  }
  if (t.length) out.push(t);

  return out;
}

/* ============================
   サーバー起動
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ くまお先生 起動完了！");
});
