import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

const app = express();

// ==============================
// 環境変数
// ==============================
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ==============================
// 会話状態（超重要）
// ==============================
global.userState = {
  mode: "menu", // menu / question / lecture / practice / chat
  lastImageBase64: null,
};

// ==============================
// Webhook 検証
// ==============================
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
      res.status(500).end();
    }
  }
);

// ==============================
// メイン処理
// ==============================
async function handleEvent(event) {
  if (event.type !== "message") return;

  // ------------------------------
  // 画像メッセージ（保存のみ）
  // ------------------------------
  if (event.message.type === "image") {
    const imageBase64 = await getImageBase64(event.message.id);
    global.userState.lastImageBase64 = imageBase64;

    await client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n" +
        "このまま解説するなら「そのまま解説して」って言ってね😊",
    });
    return;
  }

  // ------------------------------
  // テキストメッセージ
  // ------------------------------
  if (event.message.type !== "text") return;
  const text = event.message.text.trim();

  // ===== 解説トリガー =====
  if (text.includes("そのまま解説")) {
    if (!global.userState.lastImageBase64) {
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "問題の画像を先に送ってね🐻💦",
      });
      return;
    }

    const prompt = `
あなたは「くまお先生」。
生徒はすでに「そのまま解説して」と言っています。

・途中で質問を挟まない
・最初から最後まで順番に説明
・やさしく、明るく、板書のように整理
・数学・理科は【解き方】を 1⃣2⃣3⃣… で書く
・最後にノートまとめを出す

ノート構成：
【今日のまとめ】
【ポイント】
【解き方】

語尾：
「このページ、ノートに写しておくと復習しやすいよ🐻✨」
`;

    const result = await callVision(
      global.userState.lastImageBase64,
      prompt
    );

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: result,
    });

    // 状態リセット
    global.userState.mode = "menu";
    global.userState.lastImageBase64 = null;
    return;
  }
// ==============================
// メニュー表示（必ず反応する安全装置）
// ==============================
async function replyMenu(replyToken) {
  await client.replyMessage(replyToken, {
    type: "text",
    text: "こんにちは🐻✨\n今日は何をする？",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "message",
            label: "✏️ 質問がしたい",
            text: "質問がしたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "📘 講義を受けたい",
            text: "講義を受けたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "📝 演習がしたい",
            text: "演習がしたい"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "☕ 雑談がしたい",
            text: "雑談がしたい"
          }
        }
      ]
    }
  });
}

  // ===== モード選択 =====
  if (text.includes("質問")) {
    global.userState.mode = "question";
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "OKだよ🐻✨ 質問だね！問題文や写真を送ってね😊",
    });
    return;
  }

  if (text.includes("講義")) {
    global.userState.mode = "lecture";
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "講義だね📘 どの単元を聞きたいか教えてね🐻✨",
    });
    return;
  }

  // ===== 初期メニュー =====
  await client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "こんにちは😊🐻\n\n" +
      "今日は何をする？\n" +
      "👇 えらんでね！\n\n" +
      "① 質問がしたい ✏️\n" +
      "② 講義を受けたい 📘\n" +
      "③ 演習したい 📝\n" +
      "④ 雑談したい ☕\n\n" +
      "問題の写真はそのまま送ってOKだよ✨",
  });
}

// ==============================
// Vision API
// ==============================
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
          content:
            "あなたは、やさしく明るく、生徒に寄り添う先生です。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: instructions },
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

// ==============================
// 画像取得
// ==============================
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

// ==============================
app.listen(3000, () => {
  console.log("くまお先生 起動中 🐻✨");
});
