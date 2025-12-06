const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
require('dotenv').config();

// 💾 ユーザー状態保存
const globalState = {};

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

// ✅ ヘルスチェック用
app.get('/healthz', (_, res) => res.status(200).json({ ok: true }));

// 🌐 Webhookエンドポイント
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ ok: true }); // ← 超重要！！！
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

// 🎯 イベントルーター
async function handleEvent(event) {
  // 🟣 ボタン（postback）に対応
  if (event.type === "postback") {
    return handlePostback(event);
  }

  // 🟣 テキスト・画像
  if (event.type === "message") {

    if (event.message.type === "text") {
      return handleText(event);
    }

    if (event.message.type === "image") {
      return handleImage(event);
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "テキストと画像に対応してるよ〜📸✏️",
    });
  }
}


// 📄 テキスト処理
async function handleText(ev) {
  const text = ev.message.text.trim();
  const userId = ev.source.userId;
    // 🐻 くまお先生：最初のメニュー誘導
  // ユーザーのデータがなければ初期化してメニューを返す
  if (!globalState[userId] || !globalState[userId].mode) {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  // 「メニュー」と送られたら強制的にリセットしてメニューへ
  if (text === "メニュー") {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  if (text === "メニュー") {
  globalState[userId] = {}; // modeリセット
  return replyMenu(ev.replyToken);
}


  const choiceMap = { あ: 0, か: 1, さ: 2, た: 3 };

  // 選択肢応答処理
  if (["あ", "か", "さ", "た"].includes(text)) {
    const state = globalState[userId];
    if (!state || !state.lastChoices) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: "今は選択肢の問題が出てないかも？\n「確認テスト: ○○」って送ってみてね🐻",
      });
    }

    const selected = choiceMap[text];
    const choice = state.lastChoices[selected];

    if (!choice) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: "その選択肢は今は無効だよ💦 もう一度送ってみてね！",
      });
    }

    if (choice.isCorrect) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `✨そのとおりっ！！ よくできました🌟\n\n次の「確認テスト: ○○」もやってみよう！`,
      });
    } else if (choice.isExtra) {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `もっと詳しく知りたいんだね〜🐻\n\n${state.explanation || "解説がないよ💦"}`,
      });
    } else {
      return client.replyMessage(ev.replyToken, {
        type: 'text',
        text: `うんうん、ここは間違えてもOKだよ🌱\n\n${state.explanation || "解説がないよ💦"}`,
      });
    }
  }

  // ✅ 確認テスト
if (text.startsWith("確認テスト:")) {
  const question = text.replace("確認テスト:", "").trim();
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

  globalState[userId] = {
    lastChoices: choices,
    explanation: correct,
  };

  const bodyText = [
    `📝 ${question}`,
    ...choices.map(c => `${c.label}：${c.text}`),
    "↓ ボタンをタップして選んでね♪"
  ].join("\n");

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: bodyText,
    quickReply: {
      items: choices.map(c => ({
        type: "action",
        action: {
          type: "message",
          // 生徒に見える文字（ラベル）
          label: `${c.label}：${c.text}`,
          // Bot に届くテキスト → 「あ」「か」「さ」「た」
          text: c.label
        }
      }))
    }
  });
}


  // 🤖 GPTで普通の質問に答える
  const system = buildSystemPrompt("text");
  const response = await openaiChat([
    { role: "system", content: system },
    { role: "user", content: buildGeneralPrompt(text) }
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// 📸 画像処理
async function handleImage(ev) {
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  const system = buildSystemPrompt("image");
  const prompt = [
    "画像の数学問題を読み取り、手順を説明し、最後に【答え】を一行で書いてください。",
    "数式は LINE 向けに (a)/(b), √(), x^n などで表現すること。"
  ].join("\n");

  const response = await openaiChat([
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }
      ]
    }
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// 🔧 OpenAI通信
async function openaiChat(messages) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o",
      temperature: 0.2,
      messages,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });
    return res.data.choices?.[0]?.message?.content || "解答が取得できませんでした";
  } catch (e) {
    console.error("OpenAI error:", e.response?.data || e.message);
    return "エラーが発生したよ💦";
  }
}

// 📜 ユーティリティ
function sanitize(s = "") {
  return s
    .replace(/¥/g, "\\")
    .replace(/\$\$?/g, "")
    .replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)")
    .replace(/\\sqrt{([^}]+)}/g, "√($1)")
    .replace(/\^\{([^}]+)\}/g, "^$1")
    .replace(/\\cdot/g, "×")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pm/g, "±")
    .replace(/\\[A-Za-z]+/g, "");
}

function withKumaoHighlights(s = "") {
  if (!/【答え】/.test(s)) {
    s += "\n\n（わからないことがあったらまた聞いてね🐻）";
  }
  return s;
}

function buildSystemPrompt(mode) {
  return [
    "あなたは『くまお先生』。優しく、正確に、記号はLINEで崩れない形式で。",
    mode === "image" ? "最後は必ず一行で【答え】を書いてください。" : ""
  ].join("\n");
}

function buildGeneralPrompt(text) {
  return `次の内容をやさしく説明してください：\n\n${text}`;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

async function handlePostback(ev) {
  const data = ev.postback.data; // 例：choice=A
  const userId = ev.source.userId;

  // 🟣 4択の回答処理（中身はこのあと作る）
  if (data.startsWith("choice=")) {
    const selected = data.replace("choice=", ""); // A/B/C/D
    return processChoice(ev, selected);
  }
}

// 🚀 起動
const PORT = process.env.PORT || 8880;
// ヘルスチェック
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🧪 StudyEye LINE Bot Running on port ${PORT}`);
});

function replyMenu(replyToken) {
  const menuText = `
はじめまして〜🐻✨  
くまお先生だよ。

わからないところや、学びたいところがあったら  
いっしょにゆっくり進めていこうね。

画像は100％読み取れないこともあるから、  
読めなかったら文章で送ってくれても大丈夫だよ🌱  
数学・物理・化学は、答えを先に教えてくれると  
考え方をもっとていねいに説明できるよ✨

さて、今日はどうしたいかな？  
  `.trim();

  return client.replyMessage(replyToken, {
    type: "text",
    text: menuText,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "message",
            label: "質問したいよ〜🐻",
            text: "質問したいよ〜🐻"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "授業をうけたいな✨",
            text: "授業をうけたいな✨"
          }
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "演習したい！",
            text: "演習したい！"
          }
        }
      ]
    }
  });
}

// 🟦 質問モードを開始する（生徒が「質問したい！」を押した時）
function startQuestionMode(ev) {
  const userId = ev.source.userId;

  // 質問モード初期化（STEP解析の準備）
  globalState[userId] = {
    mode: "question",
    step: 0,           // STEPは0から開始
    question: "",      // 問題文 or 画像URL
    answer: "",        // 数学などで答えを先に送ってもらう目的
  };
// 🟦 質問モード中のメッセージを処理する本体（まだ中身なし）
// 質問モードのメイン処理
async function handleQuestionInput(ev) {
  const userId = ev.source.userId;
  const state = globalState[userId];

  switch (state.step) {

    // ---------------------------------------------------------
    // 🟦 STEP0：問題を受け取るフェーズ
    // ---------------------------------------------------------
    case 0: {
      let questionText = "";
      let questionImage = "";

      if (ev.message.type === "image") {
        questionImage = ev.message.id;
      } else if (ev.message.type === "text") {
        questionText = ev.message.text.trim();
      }

      // どちらも空 → エラー
      if (!questionText && !questionImage) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "問題文（または画像）が届いていないみたい🐻💦\nもう一度送ってくれる？📘"
        });
      }

      // 正常処理：問題を保存
      state.question = {
        text: questionText,
        image: questionImage,
      };

      state.step = 1; // 次は答え待ち
      return client.replyMessage(ev.replyToken, {
  type: "text",
  text:
    "問題を受け取ったよ！🐻✨\n" +
    "つぎに『答え（数字・式・キーワードなど）』も送ってね📘\n" +
    "数学・物理・化学は特に、答えがあるとより正確に解説できるよ✍️"
});


    case 1: {
  // ----------------------------------------------
  // 🟦 STEP1：答えを受け取るフェーズ
  // ----------------------------------------------

  let ansText = "";
  if (ev.message.type === "text") {
    ansText = ev.message.text.trim();
  }

  // 画像を送ってきた → 答えとしては不可
  if (!ansText) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "ごめんね💦答えは「数字・式・キーワード」みたいに、文字で送ってほしいな📘✨",
    });
  }

  // 答えを保存
  state.answer = ansText;

  // 次のSTEPへ
  state.step = 2;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "オッケー！答えを受け取ったよ✍️✨\n" +
      "もし答えの画像もあるなら今のうちに送ってね！📷\n" +
      "それじゃあ次に進むね➡️",
  });
}


// ---------------------------------------------------------
// 🟦 STEP2：問題の意図（何を聞かれている？）
// ---------------------------------------------------------
case 2: {
  // 正解の位置を A/B/C からランダムに決定
  const positions = ["A", "B", "C"];
  const correctPos = positions[Math.floor(Math.random() * 3)];

  // GPT に理解チェック用4択と summary を作らせる
  const prompt = `
あなたは生徒に寄り添う優しいスーパー全科目先生くまおです。
次の問題が「何を聞いているか」を短くまとめ、理解チェックとして4択問題を作成してください。

【重要仕様】
- 正解は必ず ${correctPos}
- 残りの2つはもっともらしい誤答にする
- D は必ず「もっと詳しく教えて！」にする
- JSON形式で返す

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}

返す形式：
{
 "summary": "〜〜〜〜",
 "choices": {
   "A": "〜〜〜",
   "B": "〜〜〜",
   "C": "〜〜〜",
   "D": "もっと詳しく教えて！"
 },
 "correct": "${correctPos}"
}
`;

  const result = await openaiChat(prompt);
  const ai = JSON.parse(result);

  state.lastChoices = ai.choices;
  state.correct = ai.correct;
  state.summary = ai.summary;

  state.step = 3;

  return flexChoiceMessage(ev.replyToken, ai.summary, ai.choices);
}


// ---------------------------------------------------------
// 🟦 STEP3：解説フェーズ（くまお先生解説）
// ---------------------------------------------------------
case 3: {
  if (ev.message.type === "text") {
    const choice = ev.message.text.trim();

    if (choice === state.correct) {
      state.step = 4;
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "正解だよ！🐻✨すごいね！\nじゃあ次は、この問題の基礎を一緒に確認しよう📘"
      });
    }

    if (choice === "D") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "もちろんだよ🐻✨\nもっと丁寧に説明するね！"
      });
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "惜しい〜！🐻💦\nゆっくりで大丈夫だよ、もう一度考えてみよっか📘"
    });
  }
}


// ---------------------------------------------------------
// 🟦 STEP4：基礎確認フェーズ
// ---------------------------------------------------------
case 4: {
  const basic = await openaiChat(`
次の内容に基づき、生徒が理解しているか確認するための【基礎問題】を1問作成してください。

- 簡単な確認問題にする
- 文章は短め
- 数式の場合は1行で表現
- JSON不要、テキストのみ

解説内容：
${state.summary}
`);

  state.basicQuestion = basic;
  state.step = 5;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "基礎確認だよ🐻📘\n\n" + basic + "\n\n答えを送ってね！"
  });
}


// ---------------------------------------------------------
// 🟦 STEP5：理解チェック用4択（正解はABCの中でランダム）
// ---------------------------------------------------------
case 5: {
  const positions = ["A", "B", "C"];
  const correctPos = positions[Math.floor(Math.random() * 3)];

  const quizJson = await openaiChat(`
次の基礎問題に対する理解度確認の4択問題を作成してください。

【仕様】
- 正解は ${correctPos}
- A/B/C のうち正解以外は自然な誤答を生成
- D は必ず「もっと詳しく教えて！」に固定
- JSON形式で返す

基礎問題：
${state.basicQuestion}

返す形式：
{
  "question": "〜〜〜",
  "A": "〜〜〜",
  "B": "〜〜〜",
  "C": "〜〜〜",
  "D": "もっと詳しく教えて！",
  "correct": "${correctPos}"
}
`);

  let quiz;
  try {
    quiz = JSON.parse(quizJson);
  } catch (e) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "ごめんね💦クイズ生成に失敗しちゃった…🐻\nもう一度送ってみて！"
    });
  }

  state.quiz = quiz;
  state.correct = quiz.correct;
  state.step = 6;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "理解チェックだよ🐻✨\n\n" +
      quiz.question +
      "\nA: " + quiz.A +
      "\nB: " + quiz.B +
      "\nC: " + quiz.C +
      "\nD: " + quiz.D +
      "\n\nA/B/C/D で答えてね！"
  });
}


// ---------------------------------------------------------
// 🟦 STEP6：まとめ＋類題
// ---------------------------------------------------------
case 6: {
  const similar = await openaiChat(`
次の問題の理解を深めるために、類題を1問だけ作ってください。
・難易度は少しだけ上げる
・形式は自由
・テキストのみでOK

元の問題：
${state.question.text || "(画像あり)"}
`);

  state.step = 0;

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "すごい！ここまで完璧だよ🐻✨\n\n最後にもう1問だけ類題を出してみるね📘\n\n" +
      similar
  });
}



  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "了解だよ〜🐻✨\nまずは「問題文（または画像）」を送ってね！\n数学・物理・化学は答えも一緒に送ってくれると助かるよ✏️"
  });
}
