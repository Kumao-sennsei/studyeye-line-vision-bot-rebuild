// ================================================
// Part1: 基礎セットアップ
// ================================================
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
require("dotenv").config();

// 💾 全ユーザーの状態（質問 / 講義 / 演習）
const globalState = {};

// LINE設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

// ヘルスチェック
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

// Webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});
// ================================================
// Part2: OpenAI共通処理・sanitize・ユーティリティ
// ================================================

// OpenAI API（Chat Completions）
async function openaiChat(messages) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        temperature: 0.2,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    return res.data.choices?.[0]?.message?.content || "回答取得エラー💦";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "OpenAI通信でエラーが発生したよ💦";
  }
}

// 数式の整形（LINE で崩れないように変換）
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

// 「【答え】が無いときは優しい締めをつける」
function withKumaoHighlights(s = "") {
  if (!/【答え】/.test(s)) {
    s += "\n\n（わからないことがあったらまた聞いてね🐻）";
  }
  return s;
}

// GPT の役割指示（質問 ／ 画像解析）
function buildSystemPrompt(mode) {
  return [
    "あなたは『くまお先生』。優しく、正確に説明すること。",
    mode === "image"
      ? "画像処理のときは、最後に必ず一行で【答え】を書いてください。"
      : "",
  ].join("\n");
}

// 通常の質問に使うプロンプト
function buildGeneralPrompt(text) {
  return `次の内容をやさしく説明してください：\n\n${text}`;
}

// 配列シャッフル
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}
// ================================================
// Part3: メインのテキスト処理（質問／講義／演習へ振り分け）
// ================================================

async function handleText(ev) {
  const text = ev.message.text.trim();
  const userId = ev.source.userId;

  let state = globalState[userId];

  // 初回 or モードなし → メニュー
  if (!state || !state.mode) {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  // 「メニュー」と送られたら強制リセット
  if (text === "メニュー") {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  // ================================
  // メニューでのモード選択
  // ================================
  if (state.mode === "menu") {
    if (text === "質問したいよ〜🐻") {
      return startQuestionMode(ev);
    }
    if (text === "授業をうけたいな✨") {
      return startLectureMode(ev);
    }
    if (text === "演習したい！") {
      return startExerciseMode(ev);
    }

    // 上記以外 → メニューへ戻す
    return replyMenu(ev.replyToken);
  }

  // ================================
  // 質問モード
  // ================================
  if (state.mode === "question") {
    return handleQuestionMode(ev, state);
  }

  // ================================
  // 講義モード
  // ================================
  if (state.mode === "lecture") {
    return handleLectureMode(ev, state);
  }

  // ================================
  // 演習モード
  // ================================
  if (state.mode === "exercise") {
    return handleExerciseMode(ev, state);
  }

  // 万が一
  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "ごめんね💦 ちょっと混乱しちゃったみたい…「メニュー」で戻れるよ🐻"
  });
}
// ================================================
// Part4: 質問モード（STEP0〜STEP6）
// ================================================

function startQuestionMode(ev) {
  const userId = ev.source.userId;

  globalState[userId] = {
    mode: "question",
    step: 0,
    question: null,
    answer: null,
    summary: null,
    lastChoices: null,
    correct: null,
    explanation: null,
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "よし！🐻📘 今日は個別指導モードで進めるよ！\n" +
      "まずは **問題文の画像 or テキスト** を送ってね。"
  });
}

// 🎯 質問モードの本体
async function handleQuestionMode(ev, state) {

  // -----------------------
  // STEP0：問題文を受け取る
  // -----------------------
  if (state.step === 0) {
    let qText = "";
    let qImage = "";

    if (ev.message.type === "image") {
      qImage = ev.message.id;
    } else {
      qText = ev.message.text.trim();
    }

    if (!qText && !qImage) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "問題文か画像が届いてないみたいだよ🐻💦\nもう一度送ってね。"
      });
    }

    state.question = { text: qText, image: qImage };
    state.step = 1;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "問題を受け取ったよ！🐻✨\n" +
        "つぎに **この問題の答え** を送ってね。\n" +
        "数学・物理・化学は答えを教えてもらえると、\nくまお先生がより正確に本質を説明できるよ！"
    });
  }

  // -----------------------
  // STEP1：答えを受け取る
  // -----------------------
  if (state.step === 1) {
    if (ev.message.type !== "text") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "答えはテキストで送ってね🐻💦"
      });
    }

    state.answer = ev.message.text.trim();
    state.step = 2;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "ありがとう！🐻✨\n" +
        "じゃあまずはこの問題が **何をきいているのか？** を確認するね。"
    });
  }

  // -----------------------
  // STEP2：意図チェック（4択問題）
  // -----------------------
  if (state.step === 2) {
    const positions = ["A", "B", "C"];
    const correctPos = positions[Math.floor(Math.random() * 3)];

    const prompt = `
あなたは全科目スーパー家庭教師くまお先生です。
問題の意図を理解する4択を作ります。

【出力形式】
{
 "summary": "やさしい要約",
 "choices": {
   "A": "淡々とした文",
   "B": "淡々とした文",
   "C": "淡々とした文",
   "D": "もっと詳しく教えて！"
 },
 "correct": "${correctPos}"
}

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}
`;

    const res = await openaiChat(prompt);

    let ai;
    try { ai = JSON.parse(res); }
    catch {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "ちょっと乱れちゃった💦 もう一度送ってくれる？🐻"
      });
    }

    state.summary = ai.summary;
    state.lastChoices = ai.choices;
    state.correct = ai.correct;
    state.step = 3;

    return flexChoiceMessage(ev.replyToken, ai.summary, ai.choices);
  }

  // -----------------------
  // STEP3：本質解説チェック
  // -----------------------
  if (state.step === 3) {
    if (ev.message.type !== "text") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "A / B / C / D の中からえらんでね🐻📘"
      });
    }

    const choice = ev.message.text.trim();

    // 正解 → 通常くまお
    if (choice === state.correct) {
      const explanation = await openaiChat(`
あなたはやさしいくまお先生です。
生徒が本質理解できるよう短く丁寧に説明。

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}
`);
      state.explanation = explanation;
      state.step = 4;

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          explanation +
          "\n\n🐻✨ いいね！ 次は“基礎”をチェックしてみよう！"
      });
    }

    // D → スーパーくまお先生
    if (choice === "D") {
      const superExplain = await openaiChat(`
あなたはスーパーくまお先生です。
最上級にやさしく丁寧に説明します。

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}
`);
      state.explanation = superExplain;
      state.step = 4;

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          superExplain +
          "\n\n🐻💛 次は“基礎”をいっしょに確認しよう！"
      });
    }

    // 不正解 → スーパーくまお先生
    const wrongExplain = await openaiChat(`
あなたはスーパーくまお先生です。
間違えた生徒をやさしく励ましながら本質を説明。

問題文：
${state.question.text || "[画像]"}
生徒の答え：
${state.answer}
`);
    state.explanation = wrongExplain;
    state.step = 4;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        wrongExplain +
        "\n\n🐻💛 大丈夫、次は基礎を確認しようね！"
    });
  }

  // -----------------------
  // STEP4：基礎確認用4択
  // -----------------------
  if (state.step === 4) {
    const positions = ["A", "B", "C"];
    const correctPos = positions[Math.floor(Math.random() * 3)];

    const prompt = `
基礎理解を確認する4択を作成。

【出力】
{
 "question": "基礎の質問文",
 "choices": {...},
 "correct": "${correctPos}"
}

問題文：
${state.question.text}

生徒の答え：
${state.answer}

前の解説：
${state.explanation}
`;

    const res = await openaiChat(prompt);

    let ai;
    try { ai = JSON.parse(res); }
    catch {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "ごめんね💦 もう一度送ってくれる？"
      });
    }

    state.lastChoices = ai.choices;
    state.correct = ai.correct;
    state.step = 5;

    return flexChoiceMessage(ev.replyToken, ai.question, ai.choices);
  }

  // -----------------------
  // STEP5：途中式チェック（次に何する？）
  // -----------------------
  if (state.step === 5) {
    const positions = ["A", "B", "C"];
    const correctPos = positions[Math.floor(Math.random() * 3)];

    const prompt = `
途中の操作理解チェックを生成。

【出力】
{
 "question": "途中式の質問",
 "choices": {...},
 "correct": "${correctPos}"
}
    
問題文：
${state.question.text}
`;

    const res = await openaiChat(prompt);

    let ai;
    try { ai = JSON.parse(res); }
    catch {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "ごめんね💦 もう一度送ってね。"
      });
    }

    state.lastChoices = ai.choices;
    state.correct = ai.correct;
    state.step = 6;

    return flexChoiceMessage(ev.replyToken, ai.question, ai.choices);
  }

  // -----------------------
  // STEP6：まとめ＋類題（4択なし）
  // -----------------------
  if (state.step === 6) {
    const prompt = `
まとめと類題を生成。

【出力】
{
 "summary": "...",
 "related": {
   "question": "...",
   "explanation": "...",
   "answer": "..."
 }
}

問題文：
${state.question.text}

生徒の答え：
${state.answer}

解説：
${state.explanation}
`;

    const res = await openaiChat(prompt);

    let ai;
    try { ai = JSON.parse(res); }
    catch {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "類題生成に失敗しちゃった💦 もう一度お願い🐻"
      });
    }

    // リセット
    state.step = 0;
    state.lastChoices = null;
    state.correct = null;

    const msg =
      `📘 **まとめ**\n${ai.summary}\n\n` +
      `📘 **類題**\n${ai.related.question}\n\n` +
      `📘 **解説**\n${ai.related.explanation}\n\n` +
      `【答え】${ai.related.answer}\n\n` +
      "🐻✨ よくできたね！\n別の問題も送ってみる？";

    return client.replyMessage(ev.replyToken, { type: "text", text: msg });
  }
}
// ================================================
// Part5: 講義モード（科目＋単元 → くまお授業）
// ================================================

async function startLectureMode(ev) {
  const userId = ev.source.userId;

  // モード初期化
  globalState[userId] = {
    mode: "lecture",
    step: 0,
    subject: "",
    unit: ""
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "よ〜し、授業モードに入るよ🐻📘✨\n" +
      "まずは **科目** を教えてね！\n例：数学 / 物理 / 化学 / 英語 / 国語 / 社会"
  });
}


// 🎯 講義モード本体
async function handleLectureMode(ev, state) {
  const msg = ev.message.text.trim();

  // ------------------------------
  // STEP0：科目を受け取る
  // ------------------------------
  if (state.step === 0) {
    state.subject = msg;
    state.step = 1;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        `OK！🐻✨ 科目は **${msg}** だね！\n` +
        "次は **単元（テーマ）** を教えてね。\n例：因数分解 / 電磁気 / 酸塩基 / 文法 / 古文読解 etc..."
    });
  }

  // ------------------------------
  // STEP1：単元を受け取る → 講義スタート
  // ------------------------------
  if (state.step === 1) {
    state.unit = msg;
    state.step = 2;

    // GPT に講義（ノート風）を作成させる
    const lecture = await openaiChat(`
あなたは優しく丁寧に教える「くまお先生」です。

【目的】
生徒がノートを取りやすいように、要点がまとまった「講義」を作る。

【講義の条件】
- 最重要ポイントを順番に説明
- 適度に区切って読みやすく
- 数式・例題を入れてもOK
- トーンは通常くまお（優しく寄り添う）
- 長すぎず、しかし内容はしっかり

【出力形式】
「講義内容のみ」

科目：${state.subject}
単元：${state.unit}
    `);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "📘 **くまお先生の講義ノート**\n" +
        lecture +
        "\n\n次はどうする？\n・「もう1回ききたい」\n・「別の単元」\n・「演習したい！」\n・「メニュー」"
    });
  }

  // ------------------------------
  // STEP2：講義後の反応
  // ------------------------------
  if (state.step === 2) {

    if (msg === "もう1回ききたい") {
      return handleLectureMode(ev, { ...state, step: 1 });
    }

    if (msg === "別の単元") {
      state.step = 1;
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "OK！🐻✨ 新しい単元を教えてね！"
      });
    }

    if (msg === "演習したい！") {
      return startExerciseMode(ev); // 演習モードへバトンタッチ
    }

    if (msg === "メニュー") {
      globalState[ev.source.userId] = { mode: "menu" };
      return replyMenu(ev.replyToken);
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "次はどうする？\n\n・「もう1回ききたい」\n・「別の単元」\n・「演習したい！」\n・「メニュー」"
    });
  }
}
// ================================================
// Part6：統合ルーター（全モード切替の中枢部）
// ================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // ---- Postback（未使用だが将来用） ----
  if (event.type === "postback") {
    return handlePostback(event);
  }

  // ---- メッセージ受信 ----
  if (event.type === "message") {
    const msgType = event.message.type;

    // 画像 → 質問モードへ渡す
    if (msgType === "image") {
      return handleImage(event);
    }

    // テキスト
    if (msgType === "text") {
      return handleText(event);
    }
  }
}


// ================================================
// handleText：全モードの入口
// ================================================

async function handleText(ev) {
  const text = ev.message.text.trim();
  const userId = ev.source.userId;

  // ▼ メニューコマンドはいつでも強制遷移
  if (text === "メニュー") {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  // ▼ ユーザー状態取得（なければメニュー）
  if (!globalState[userId] || !globalState[userId].mode) {
    globalState[userId] = { mode: "menu" };
    return replyMenu(ev.replyToken);
  }

  const state = globalState[userId];

  // ===========================================
  // ① モード選択メニュー
  // ===========================================
  if (state.mode === "menu") {

    if (text === "質問したいよ〜🐻") {
      return startQuestionMode(ev);
    }

    if (text === "授業をうけたいな✨") {
      return startLectureMode(ev);
    }

    if (text === "演習したい！") {
      return startExerciseMode(ev);
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "やりたいことを選んでね🐻✨\n\n・質問したいよ〜🐻\n・授業をうけたいな✨\n・演習したい！"
    });
  }

  // ===========================================
  // ② 質問モード（STEP0〜STEP6）
  // ===========================================
  if (state.mode === "question") {
    return handleQuestionMode(ev, state);
  }

  // ===========================================
  // ③ 講義モード（科目 → 単元 → 講義）
  // ===========================================
  if (state.mode === "lecture") {
    return handleLectureMode(ev, state);
  }

  // ===========================================
  // ④ 演習モード（1問 → 解答 → 判定）
  // ===========================================
  if (state.mode === "exercise") {
    return handleExerciseMode(ev, state);
  }

  // ===========================================
  // ⑤ 想定外 → 強制メニュー
  // ===========================================
  globalState[userId] = { mode: "menu" };
  return replyMenu(ev.replyToken);
}
