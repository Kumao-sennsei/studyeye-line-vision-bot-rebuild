/**
 * eternal_final (hotfix) - Env names aligned to user's convention
 * Uses: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY
 * Also supports legacy: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ---- Env names (user-first) ----
const CHANNEL_ACCESS_TOKEN =
  process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN;

const CHANNEL_SECRET =
  process.env.CHANNEL_SECRET || process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

const PORT = process.env.PORT || 3000;

// Verify env vars
if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error("❌ Missing environment variables. Need CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY.");
  process.exit(1);
}

// LINE reply helper
async function replyToLine(replyToken, messages) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      { replyToken, messages },
      { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error("LINE Reply Error:", err.response?.data || err.message);
  }
}

// OpenAI API call (text)
async function getTextResponse(userText) {
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'あなたは「くまお先生」です。絵文字はほどほどに、楽しく、面白く、やさしく、わかりやすく説明してください。' },
          { role: 'user', content: userText }
        ],
        temperature: 0.4
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("OpenAI Text Error:", err.response?.data || err.message);
    return "今日はちょっと調子が悪いみたい。また試してみてね！";
  }
}

// OpenAI API call (image)
async function getImageAnalysis(imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'あなたは「くまお先生」です。画像をやさしく、面白く、わかりやすく解説してください。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'この画像について説明してください。' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
            ]
          }
        ],
        temperature: 0.4
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("OpenAI Image Error:", err.response?.data || err.message);
    return "画像を読み込めなかったよ。もう一度送ってみてね！";
  }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  for (const event of events) {
    if (event.type === 'message') {
      const message = event.message;
      if (message.type === 'text') {
        const replyText = await getTextResponse(message.text);
        await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
      } else if (message.type === 'image') {
        try {
          // Get image content from LINE
          const contentResp = await axios.get(
            `https://api-data.line.me/v2/bot/message/${message.id}/content`,
            {
              headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
              responseType: 'arraybuffer'
            }
          );
          const replyText = await getImageAnalysis(Buffer.from(contentResp.data));
          await replyToLine(event.replyToken, [{ type: 'text', text: replyText }]);
        } catch (err) {
          console.error("Image Fetch Error:", err.response?.data || err.message);
          await replyToLine(event.replyToken, [{ type: 'text', text: "画像を取得できなかったよ。もう一度送ってみてね！" }]);
        }
      } else {
        await replyToLine(event.replyToken, [{ type: 'text', text: "今はテキストと画像だけに対応してるよ。" }]);
      }
    }
  }
  res.sendStatus(200);
});

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🐻 Kumao-sensei bot (hotfix) listening on port ${PORT}`);
});