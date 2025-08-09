// index.js
import express from "express";
import line from "@line/bot-sdk";
import fetch from "node-fetch";

// ====== 環境変数読み込み ======
const config = {
  channelAccessToken:
    process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:
    process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET,
};

const openaiApiKey = process.env.OPENAI_API_KEY;

if (!config.channelAccessToken || !config.channelSecret) {
  console.error("❌ Channel Access Token または Secret が設定されていません");
  process.exit(1);
}
if (!openaiApiKey) {
  console.error("❌ OPENAI_API_KEY が設定されていません");
  process.exit(1);
}

// ====== LINE クライアント作成 ======
const client = new line.Client(config);
const app = express();

// ====== 署名検証とJSONパース ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ====== イベント処理 ======
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  try {
    // OpenAI APIへ送信
    const aiReply = await getOpenAIResponse(userMessage);

    // LINEに返信
    await client.replyMessage(replyToken, {
      type: "text",
      text: aiReply,
    });
  } catch (err) {
    console.error("返信エラー:", err);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "エラーが発生しました…(；ω；)",
    });
  }
}

// ====== OpenAIへの問い合わせ ======
async function getOpenAIResponse(userMessage) {
  const apiUrl = "https://api.openai.com/v1/chat/completions";
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "あなたは優しく面白いくまお先生です。絵文字も適度に入れて回答します。" },
        { role: "user", content: userMessage },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message);
  }
  return data.choices[0].message.content.trim();
}

// ====== サーバー起動 ======
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
