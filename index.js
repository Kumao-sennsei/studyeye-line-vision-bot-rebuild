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
   Webhook（署名検証）
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
      res.status(200).end(); // ← 必ず 200
    } catch (err) {
      console.error("Webhook Error:", err);
      res.status(200).end(); // ここも 200
    }
  }
);

/* ===========================================================
      ここから "handleEvent は 1 個だけ" の完全統合コード
=========================================================== */
async function handleEvent(event) {
  const userId = event.source.userId;

  /* =====================
        画像が届いた（質問モード）
  ====================== */
  if (event.message.type === "image") {
    userState[userId] = {
      mode: "question_waiting_answer",
      imageId: event.message.id,
    };

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "画像を受け取ったよ🐻✨\n\n" +
        "この問題の“公式の答え（解答冊子の答え）”を送ってね。\n" +
        "ない場合は「答えなし」でOKだよ！",
    });
  }

  /* =====================
        テキストが届いた
  ====================== */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* ---- あいさつ：メニュー表示 ---- */
    if (["こんにちは", "こんちは", "やあ", "はじめまして"].includes(text)) {
      return replyMenu(event.replyToken);
    }
/* =====================
   Vision 質問モード
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは優しく明るく板書のように説明する「くまお先生」です。
以下のルールを必ず守ってください。

【禁止事項】
・Markdownの太字（** など）
・LaTeX（\\( \\) や \\[ \\]）
・装飾記号の乱用
・ChatGPTっぽい文章

【書き方ルール】
・語尾はやさしく丁寧に
・文章は短く、板書のように区切る
・数式は「x^3 を x の 3乗」と日本語で書く
・箇条書きは「・」のみ

【解答フォーマット】
1. 問題の要点  
　画像から読み取った内容を簡潔にまとめる

2. 解き方  
　ステップ1  
　ステップ2  
　ステップ3（必要な場合のみ）

3. 解説  
　考え方を落ち着いてゆっくり説明する  
　計算の途中もかみ砕いて文章で補足する

4. 答え  
　公式の答えがある場合 → それを基準  
　公式の答えが無い場合 → 自分で答えを出す

最後は必ず  
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
              ? `この問題の公式の答えは「${officialAnswer}」です。この答えを基準に解説してください。`
              : "公式の答えはありません。問題を読み取り、自分で解いて説明してください。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ];

  return await callOpenAI(messages);
}
