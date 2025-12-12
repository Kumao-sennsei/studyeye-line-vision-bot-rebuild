import express from "express";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

/* =====================
  環境変数
===================== */
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ---- 簡易メモリ（本当は DB 推奨） ----
const userState = {};   // userId → { mode: "question" | "lecture" | "exercise" | "chat" }

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
    } catch (err) {
      console.error(err);
      res.status(200).end();
    }
  }
);

/* =====================
  メイン処理
===================== */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source.userId;
  if (!userState[userId]) userState[userId] = { mode: null };

  const mode = userState[userId].mode;
  const text = event.message.text.trim();

  /* ====== メニュー表示ワード ====== */
  if (["こんにちは", "メニュー", "はじめまして"].includes(text)) {
    userState[userId].mode = null;
    return replyMenu(event.replyToken);
  }

 // ==============================
// 質問モード：テキスト & 画像
// ==============================
async function handleQuestionMode(event, userId) {
  // ---- ① 画像質問の場合（Vision） ----
  if (event.message.type === "image") {
    const imageBase64 = await getImageBase64(event.message.id);

    const prompt = `
あなたは「くまお先生」。
生徒が送った問題を、そのまま優しく丁寧に解説してください。

・説明はステップ順で
・途中で質問しない
・黒板の板書のように整理して
・数学や理科の計算は【解き方】1⃣2⃣3⃣…で書く
・最後にノートまとめを書く

【ノート構成】
◆ 今日のまとめ
◆ ポイント
◆ 解き方（計算問題のみ）
`;

    const explanation = await callVision(imageBase64, prompt);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: explanation,
    });

    return;
  }

  // ---- ② テキスト質問の場合 ----
  if (event.message.type === "text") {
    const question = event.message.text;

    const prompt = `
あなたは「くまお先生」。
生徒がした質問に、やさしく丁寧にわかりやすく答えてね。

・難しい言葉は使わずに説明
・順番に解説
・例があれば例を出す
・最後に今日のまとめを書く
`;

    const answer = await callTextQA(question, prompt);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });

    return;
  }
}
async function callTextQA(question, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: question },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}
async function callVision(imageBase64, instructions) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        {
          role: "system",
          content: instructions,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "この問題を解説してください。" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
    }
  );

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}
if (mode[userId] === "question") {
  return handleQuestionMode(event, userId);
}


  /* ====== ② 講義モード ====== */
  if (text.startsWith("②")) {
    userState[userId].mode = "lecture";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "了解！講義モード📘✨\n\n" +
        "🔸 教科（例：数学、物理、化学）\n" +
        "🔸 単元（例：2次関数、電磁気、酸化還元）\n\n" +
        "この2つをスペース区切りで送ってね！\n例）数学 2次関数",
    });
  }

  if (mode === "lecture" && text.includes(" ")) {
    const [subject, unit] = text.split(" ");

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `講義を始めるよ📘✨\n\n` +
        `【教科】${subject}\n【単元】${unit}\n\n` +
        `まずは基礎から説明するね！\n（ここに講義ロジックを追加予定）`,
    });
  }

  /* ====== ③ 演習モード ====== */
  if (text.startsWith("③")) {
    userState[userId].mode = "exercise";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "演習モードだね🔥📝\n\n" +
        "🔸 教科（数学 / 物理 / 化学 など）\n" +
        "🔸 レベル（基礎 / 標準 / 難関）\n\n" +
        "例）数学 基礎",
    });
  }

  if (mode === "exercise" && text.includes(" ")) {
    const [subject, level] = text.split(" ");

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `OK！演習開始🔥\n\n` +
        `【教科】${subject}\n【レベル】${level}\n\n` +
        `第1問いくよ！\n（ここで後で問題を出す機能を入れる）`,
    });
  }

  /* ====== ④ 雑談 ====== */
  if (text.startsWith("④")) {
    userState[userId].mode = "chat";

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "雑談モードだよ☕✨\n\nなんでも話してね！",
    });
  }

  if (mode === "chat") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `いいね、その話もっと聞かせて☕✨\n\n→ ${text}`,
    });
  }

  /* ====== どれでもなければメニュー ====== */
  return replyMenu(event.replyToken);
}

/* =====================
  メニュー返信
===================== */
function replyMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text:
      "こんにちは🐻✨\n\n" +
      "今日は何をする？\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習がしたい 📝\n" +
      "④ 雑談したい ☕",
  });
}

/* =====================
  起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("くまお先生 起動中 🐻✨");
});
