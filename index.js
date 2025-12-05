const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');
const globalState = {};

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.CHANNEL_SECRET       || process.env.LINE_CHANNEL_SECRET
};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MATH_CAS_URL   = process.env.MATH_CAS_URL || "";

if (!config.channelAccessToken || !config.channelSecret || !OPENAI_API_KEY) {
  console.error('❌ ENV不足: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY');
  process.exit(1);
}

const client = new line.Client(config);
const app = express();
app.get('/healthz', (_,res)=>res.status(200).json({ ok:true, cas: !!MATH_CAS_URL }));
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event){
  if (event.type !== 'message') return;
  const m = event.message;
  if (m.type === 'text')  return handleText(event);
  if (m.type === 'image') return handleImage(event);
  return client.replyMessage(event.replyToken, { type:'text', text: '今はテキストと画像に対応してるよ(●´ω｀●)' });
}

async function handleText(ev){
  const userText = ev.message.text || "";
  const choiceMap = { "あ": 0, "か": 1, "さ": 2, "た": 3 };

  if (/^\d+（\d+）/.test(userText)) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "これは画像の中の問題番号っぽいね🐻✨\n計算はしないで、そのまま解説をすすめていくよ〜！"
    });
  }

  if (["あ", "か", "さ", "た"].includes(userText.trim())) {
    const userId = ev.source.userId;
    const userState = globalState[userId];

    if (userState && userState.lastChoices) {
      const selected = choiceMap[userText.trim()];
      const choice = userState.lastChoices[selected];

      if (!choice) {
        return client.replyMessage(ev.replyToken, { type: "text", text: "うーん、今は選択肢がないかも…💦 もう一度送ってみてね！" });
      }

      if (choice.isCorrect) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: `✨そのとおりっ！！\nすごいなぁ〜！よくできましたっ🌟\n\n次のステップにすすんでみよう🐻♪`
        });
      } else if (choice.isExtra) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: `なるほどっ、もっと詳しく知りたいんだね🐻！\nよーし、くまお先生がバッチリ解説しちゃうよ〜📘✨\n\n${userState.explanation || "（解説内容がまだセットされてないよ）"}`
        });
      } else {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: `うんうん、ここで間違えても大丈夫！\nいっしょに理解を深めていこうね😊\n\n${userState.explanation || "（解説内容がまだセットされてないよ）"}`
        });
      }
    } else {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "まだ確認テストを出していないみたいだよ🐻！\n「確認テスト: ～」って送ってね♪"
      });
    }
  }

  if (userText.startsWith("確認テスト:")) {
    const question = userText.replace("確認テスト:", "").trim();

    const correct = "内角の和は (n−2)×180° で求める";
    const wrong1  = "180÷n が内角の和";
    const wrong2  = "n×180 + 2 が内角の和";
    const extra   = "もっと詳しく教えて！";

    const choices = shuffle([
      { label: "あ", text: correct, isCorrect: true },
      { label: "か", text: wrong1 },
      { label: "さ", text: wrong2 },
    ]);
    choices.push({ label: "た", text: extra, isExtra: true });

    const replyText = [
      `📝 ${question}`,
      "",
      ...choices.map(c => `${c.label}：${c.text}`),
      "",
      "↓ あ・か・さ・た で選んでね♪"
    ].join("\n");

    const userId = ev.source.userId;
    globalState[userId] = {
      lastChoices: choices,
      explanation: correct
    };

    return client.replyMessage(ev.replyToken, { type: "text", text: replyText });
  }

  const mathy = isMathy(userText);
  const system = buildSystemPrompt({ answerMode:'text' });

  if (mathy) {
    const prompt = buildMathSolvePrompt(userText);
    const first  = await openaiChat({ model:'gpt-4o', messages:[
      { role:'system', content: system },
      { role:'user',   content: prompt }
    ]});
    const verify = await openaiChat({ model:'gpt-4o', temperature:0.1, messages:[
      { role:'system', content: system },
      { role:'user',   content: "今の解を別の観点で短く検算し、一致しなければ修正して整合させて。" }
    ]});
    let merged = sanitize(`${first}\n\n🔶 検算メモ\n${verify}`);
    merged = merged.replace(/\n?【答え】.*/gs, "").trim();

    if (MATH_CAS_URL && /∫|integral|dx|dy/.test(userText)) {
      try {
        const cas = await casCompute({ task:'auto', input:userText });
        if (cas && cas.result) {
          merged += `\n\n🔷 CAS検算: ${cas.resultSummary || cas.result}`;
        }
      } catch(e) { console.error('CAS error:', e.message); }
    }

    const out = withKumaoHighlights(merged);
    return client.replyMessage(ev.replyToken, { type:'text', text: out });
  }

  const general = await openaiChat({ model:'gpt-4o-mini', messages:[
    { role:'system', content: system },
    { role:'user',   content: buildGeneralPrompt(userText) }
  ]});
  const out = withKumaoHighlights(sanitize(general).replace(/\n?【答え】.*/gs,""));
  return client.replyMessage(ev.replyToken, { type:'text', text: out });
}

// 画像処理・ユーティリティ関数などはそのまま下に続く
