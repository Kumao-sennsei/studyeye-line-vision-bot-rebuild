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
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      }
    );
    return res.data.choices?.[0]?.message?.content || "回答取得エラー💦";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "OpenAI通信でエラーが発生したよ💦";
  }
}

// 数式整形（LINE 崩れ対策）
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
    "あなたは『くまお先生』。優しく、正確に説明すること。",
    mode === "image"
      ? "画像処理時は、最後に必ず一行で【答え】を書いてください。"
      : "",
  ].join("\n");
}

function buildGeneralPrompt(text) {
  return `次の内容をやさしく説明してください：\n\n${text}`;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}
// ================================================
// Part2: メニュー表示（メインメニュー画面）
// ================================================
function replyMenu(replyToken) {
  const menuText = `
はじめまして〜🐻✨  
くまお先生だよ。

わからないところや学びたいところがあれば、  
いっしょにゆっくり進めていこうね。

さて今日はどうしたいかな？  
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
            text: "質問したいよ〜🐻",
          },
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "授業をうけたいな✨",
            text: "授業をうけたいな✨",
          },
        },
        {
          type: "action",
          action: {
            type: "message",
            label: "演習したい！",
            text: "演習したい！",
          },
        },
      ],
    },
  });
}

// ================================================
// Part2（続き）: 画像 → GPTで解答
// ================================================
async function handleImage(ev) {
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  const system = buildSystemPrompt("image");
  const prompt = [
    "画像の数学問題を読み取り、手順を説明し、最後に【答え】を一行で書いてください。",
    "数式は (a)/(b), √(), x^n のようにLINEで崩れない表現を使うこと。",
  ].join("\n");

  const response = await openaiChat([
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    },
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// ================================================
// Part2（メインルーター）
// ================================================
async function handleEvent(event) {
  const userId = event.source.userId;

  // ---- Postback（将来用） ----
  if (event.type === "postback") {
    return handlePostback(event);
  }

  // ---- 画像 ----
  if (event.type === "message" && event.message.type === "image") {
    const state = globalState[userId] || {};

    if (state.mode === "question") {
      return handleQuestionMode(event, state);
    }
    return handleImage(event);
  }

  // ---- テキスト ----
  if (event.type === "message" && event.message.type === "text") {
    return handleText(event);
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨",
  });
}
// ================================================
// Part3: 質問モード（STEP0〜STEP6）
// ================================================

// ▼ 質問モード開始
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
      "よし！🐻📘 個別指導モードに入ったよ！\n" +
      "まずは **問題文の画像 or テキスト** を送ってね。"
  });
}

// ▼ 質問モード本体
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
        "（答えがあると、くまお先生がより正確に解説できるよ）"
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
        "じゃあまずは **この問題が何を聞いているのか？** を確認するね。"
    });
  }

  // -----------------------
  // STEP2：意図チェック（4択）
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
        text: "A / B / C / D の中から選んでね🐻📘"
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
  // STEP4：基礎確認4択
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
  // STEP5：途中式チェック
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
  // STEP6：まとめ＋類題生成
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
// Part4: 講義モード（科目＋単元 → くまお授業）
// ================================================

// ▼ 講義モード開始
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
      "よ〜し、授業モードにはいったよ🐻📘✨\n" +
      "まずは **科目** を教えてね！\n例：数学 / 物理 / 化学 / 英語 / 国語 / 社会"
  });
}


// ▼ 講義モード本体
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
        "次は **単元（テーマ）** を教えてね。\n例：因数分解 / 電磁気 / 酸塩基 / 文法 / 古文読解 など！"
    });
  }

  // ------------------------------
  // STEP1：単元を受け取る → 講義スタート
  // ------------------------------
  if (state.step === 1) {
    state.unit = msg;
    state.step = 2;

    // GPT に講義を生成（ノート風）
    const lecture = await openaiChat(`
あなたは優しく丁寧に教える「くまお先生」です。

【目的】
生徒がノートを取りやすいように、要点がまとまった講義をつくる。

【講義の条件】
- 最重要ポイントを順番に説明
- 適度に区切って読みやすく
- 数式・例を交えてOK
- トーンは優しく寄り添う「くまお」
- 長すぎず、でも内容はしっかり

【出力】
講義本文のみ

科目：${state.subject}
単元：${state.unit}
    `);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "📘 **くまお先生の講義ノート**\n" +
        lecture +
        "\n\n次はどうする？🐻✨\n" +
        "・「もう1回ききたい」\n" +
        "・「別の単元」\n" +
        "・「演習したい！」\n" +
        "・「メニュー」"
    });
  }

  // ------------------------------
  // STEP2：講義後の生徒の選択
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

    if (msg === "演習したい！」 || msg === "演習したい!") {
      return startExerciseMode(ev);
    }

    if (msg === "メニュー") {
      globalState[ev.source.userId] = { mode: "menu" };
      return replyMenu(ev.replyToken);
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "どうする？🐻\n" +
        "・「もう1回ききたい」\n" +
        "・「別の単元」\n" +
        "・「演習したい！」\n" +
        "・「メニュー」"
    });
  }
}
// ================================================
// Part5: 演習モード（1問 → 解答 → くまお判定）
// ================================================

// ▼ 演習モード開始
async function startExerciseMode(ev) {
  const userId = ev.source.userId;

  globalState[userId] = {
    mode: "exercise",
    step: 0,
    question: "",
    answer: "",
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "よーし！🐻🔥 演習モードに入るよ！\n" +
      "まずは軽いウォーミングアップ問題を1問出すね。\n" +
      "準備できたら「OK」と送ってね📘"
  });
}


// ▼ 演習モード本体（STEP0〜STEP2）
async function handleExerciseMode(ev, state) {
  const msg = ev.message.text.trim();

  switch (state.step) {

    // ---------------------------------------------------------
    // STEP0：準備OK → GPTが問題を1問生成
    // ---------------------------------------------------------
    case 0: {
      if (msg !== "OK") {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "準備できたら「OK」と送ってね🐻📘"
        });
      }

      // GPTに演習問題を作らせる
      const q = await openaiChat(`
あなたは「くまお先生」です。
中学生〜高校生向けの数学・物理・化学から、難易度普通の演習問題を1問だけ作成してください。

条件:
- 問題文のみを返す（答えを書かない）
- 短く明確
      `);

      state.question = q;
      state.step = 1;

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          "📘 **演習問題**\n" +
          q +
          "\n\n解けたら答えを送ってね🐻✏️"
      });
    }

    // ---------------------------------------------------------
    // STEP1：生徒の回答を受け取る → 判定へ
    // ---------------------------------------------------------
    case 1: {
      state.answer = msg;
      state.step = 2;

      return checkExerciseAnswer(ev, state);
    }
  }
}


// ----------------------------------------------------------
// GPTによる採点（正解 → 褒める / 誤答 → スーパーくまお）
// ----------------------------------------------------------
async function checkExerciseAnswer(ev, state) {

  const evaluation = await openaiChat(`
あなたは「くまお先生」です。
今から生徒の回答が正しいかどうかを判定し、コメントを返してください。

【出力形式】
{
 "correct": true or false,
 "explanation": "正解なら短く褒める。誤答ならスーパーくまお先生で優しく丁寧に本質から教える。"
}

問題：
${state.question}

生徒の答え：
${state.answer}
  `);

  let ai;
  try { ai = JSON.parse(evaluation); }
  catch (e) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "採点がちょっと乱れちゃった💦 もう一度答えを送ってくれる？🐻"
    });
  }

  // 🎉 正解！
  if (ai.correct) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "💮 **正解！すばらしい！！**\n\n" +
        ai.explanation +
        "\n\n次はどうする？\n・「もう1問！」\n・「難しめに挑戦！」\n・「メニュー」"
    });
  }

  // 💛 誤答 → スーパーくまお発動
  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "🐻💛 間違えてもぜんぜん大丈夫だよ。\n" +
      "ここから一緒に成長していこうね。\n\n" +
      ai.explanation +
      "\n\nどうする？\n・「もう1問！」\n・「難しめに挑戦！」\n・「メニュー」"
  });
}
// ================================================
// Part6：統合ルーター（全モード切替の中枢部）
// ================================================

async function handleEvent(event) {
  const userId = event.source.userId;

  // 状態がなければメニューに初期化
  if (!globalState[userId]) {
    globalState[userId] = { mode: "menu" };
  }

  const state = globalState[userId];

  // -------------------------------------------------
  // ① Postback（将来拡張用・今は通常返信）
  // -------------------------------------------------
  if (event.type === "postback") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ボタンを受け取ったよ🐻✨（現在は未対応だよ）"
    });
  }

  // -------------------------------------------------
  // ② メッセージ受信（画像 or テキスト）
  // -------------------------------------------------
  if (event.type === "message") {
    const msgType = event.message.type;

    // 🔹 画像 → 質問モード中なら質問処理、それ以外は通常画像解析
    if (msgType === "image") {
      if (state.mode === "question") {
        return handleQuestionMode(event, state);
      }
      return handleImage(event);
    }

    // 🔹 テキスト
    if (msgType === "text") {
      const text = event.message.text.trim();

      // ------------------------------
      // 📌「メニュー」で強制初期化
      // ------------------------------
      if (text === "メニュー") {
        globalState[userId] = { mode: "menu" };
        return replyMenu(event.replyToken);
      }

      // ------------------------------
      // ③ モード選択
      // ------------------------------
      if (text === "質問したいよ〜🐻") {
        return startQuestionMode(event);
      }
      if (text === "授業をうけたいな✨") {
        return startLectureMode(event);
      }
      if (text === "演習したい！") {
        return startExerciseMode(event);
      }

      // ------------------------------
      // ④ 各モード継続
      // ------------------------------
      if (state.mode === "question") {
        return handleQuestionMode(event, state);
      }
      if (state.mode === "lecture") {
        return handleLectureMode(event, state);
      }
      if (state.mode === "exercise") {
        return handleExerciseMode(event, state);
      }

      // ------------------------------
      // ⑤ どのモードでもない → 通常質問
      // ------------------------------
      return handleGeneralQuestion(event);
    }
  }

  // ここまでで判定できないメッセージ
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻✨"
  });
}
