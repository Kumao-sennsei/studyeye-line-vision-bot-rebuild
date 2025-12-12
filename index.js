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

 // ===========================
//  質問モードの処理（画像 & テキスト）
// ===========================
async function handleQuestionMode(event) {
  const userId = event.source.userId;

  // -------------------------------------
  // ① 画像質問（Vision API）
  // -------------------------------------
  if (event.message.type === "image") {
    try {
      // 画像を取得
      const stream = await client.getMessageContent(event.message.id);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);

      // OpenAI Vision に送る
      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "あなたは優しい家庭教師くまお先生です。写真の内容を分析し、質問に丁寧に答えてください。",
          },
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image: imageBuffer.toString("base64"),
              },
              {
                type: "text",
                text: "この画像について説明してください。",
              },
            ],
          },
        ],
        max_tokens: 500,
      });

      const answer = result.choices[0].message.content;

      return reply(event, {
        type: "text",
        text: `📷 解説だよ！\n${answer}\n\n他にも質問ある？🐻✨`,
      });
    } catch (err) {
      console.error("Vision Error:", err);
      return reply(event, {
        type: "text",
        text: "ごめんね💦 画像の解析に失敗しちゃった…もう一回送ってみてね！",
      });
    }
  }

  // -------------------------------------
  // ② テキスト質問
  // -------------------------------------
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "あなたは優しい家庭教師くまお先生です。質問に対して短く・分かりやすく答えてください。",
          },
          { role: "user", content: text },
        ],
        max_tokens: 500,
      });

      const answer = completion.choices[0].message.content;

      return reply(event, {
        type: "text",
        text: `📝 解説だよ！\n${answer}\n\n他にも質問ある？🐻✨`,
      });
    } catch (err) {
      console.error("Chat Error:", err);
      return reply(event, {
        type: "text",
        text: "ごめんね💦 うまく答えられなかった…もう一度質問してみて！",
      });
    }
  }

  // -------------------------------------
  // ③ 万が一のフォールバック
  // -------------------------------------
  return reply(event, {
    type: "text",
    text: "質問モードだよ！📘\n文章か写真で質問してね！",
  });
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
