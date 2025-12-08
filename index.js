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
// ※ 引数は「messages配列」でも「string（=user発話）」でもOKにしてある
async function openaiChat(messagesOrText) {
  let messages;
  if (typeof messagesOrText === "string") {
    messages = [{ role: "user", content: messagesOrText }];
  } else {
    messages = messagesOrText;
  }

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



// ================================================
// 数学・物理・化学の整形フィルタ（強化版 sanitizeMath）
// ================================================
function sanitizeMath(text = "") {
  if (!text) return "";

  let t = text;

  // ------------------------------------------------
  // ① LaTeX → LINE向けシンプル表記に置換
  // ------------------------------------------------
  // √
  t = t.replace(/\\sqrt{([^}]+)}/g, "√($1)");
  t = t.replace(/sqrt\(([^)]+)\)/g, "√($1)");

  // 分数
  t = t.replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)");

  // べき乗
  t = t.replace(/\^\{([^}]+)\}/g, "^($1)");
  t = t.replace(/\^([0-9]+)/g, "^$1");

  // log（底つき）
  t = t.replace(/\\log_?{?([^}]*)}?/g, "log_$1");

  // Σ（シグマ記号 → 読める形に）
  t = t.replace(/\\sum_{([^}]*)}\^{([^}]*)}/g, "Σ[$1 → $2]");

  // ∫（積分記号 → 読める形に）
  t = t.replace(/\\int_{([^}]*)}\^{([^}]*)}/g, "∫[$1 → $2]");

  // ------------------------------------------------
  // ② ベクトル・行列の定形整形
  // ------------------------------------------------
  // ベクトル → < , >
  t = t.replace(/\\vec{([^}]+)}/g, "<$1>");
  t = t.replace(/\\overrightarrow{([^}]+)}/g, "<$1>");

  // 行列（簡易）
  t = t.replace(/\\begin{pmatrix}/g, "(");
  t = t.replace(/\\end{pmatrix}/g, ")");
  t = t.replace(/\\\\/g, "; "); // 行区切り

  // ------------------------------------------------
  // ③ 漢字Mathを読みやすく（等号前後のスペース）
  // ------------------------------------------------
  t = t.replace(/=/g, " = ");
  t = t.replace(/\s+/g, " ").trim();

  // ------------------------------------------------
  // ④ “説明のための話口調補助”を追加（過度にならない）
  // ------------------------------------------------
  t = t.replace(/√\(/g, "（ここは平方根だよ→）√(");
  t = t.replace(/\(([^)]*)\)\/\(([^)]*)\)/g, "（$1 を $2 で割るよ→）($1)/($2)");

  return t;
}
function sanitizeMath(text = "") {
  if (!text) return "";

  let s = text;

  // ---- LaTeX残骸の除去 ----
  s = s.replace(/\$\$?/g, "");

  // ---- 分数 ----
  s = s.replace(/\\frac{([^}]+)}{([^}]+)}/g, "($1)/($2)");

  // ---- √（平方根） ----
  s = s.replace(/\\sqrt{([^}]+)}/g, "√($1)");

  // ---- 指数 ----
  s = s.replace(/\^\{([^}]+)\}/g, "^$1"); 
  s = s.replace(/([A-Za-z0-9])\^([A-Za-z0-9]+)/g, "$1^$2");

  // ---- 掛け算 ----
  s = s.replace(/\\cdot|\\times/g, "×");

  // ---- 割り算 ----
  s = s.replace(/\\div/g, "÷");

  // ---- ± ----
  s = s.replace(/\\pm/g, "±");

  // ---- ログ ----
  s = s.replace(/\\log_([0-9]+)\s*\{([^}]+)\}/g, "log_$1($2)");

  // ---- シグマ：Σ ----
  s = s.replace(/\\sum_{([^}]+)}\^{([^}]+)}/g,
    (_, from, to) =>
      `「${from} から ${to} まで足し合わせる」`
  );

  // ---- 積分：∫ ----
  s = s.replace(/\\int_{([^}]+)}\^{([^}]+)}/g,
    (_, from, to) =>
      `「${from} から ${to} まで積分する」`
  );

  // ---- ∫ f(x) dx （限界なし）----
  s = s.replace(/\\int\s+([^d]+)dx/g,
    (_, body) => `「${body.trim()} を積分すると…」`
  );

  // ---- その他の LaTeX コマンド削除 ----
  s = s.replace(/\\[A-Za-z]+/g, "");

  // ---- 仕上げ（スペース調整） ----
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

module.exports = { sanitizeMath };


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

// 4択をテキスト＋クイックリプライで出す Helper
function flexChoiceMessage(replyToken, title, choicesObj) {
  // choicesObj = { A: "...", B: "...", C: "...", D: "..." }
  const lines = [
    title,
    "",
    `A：${choicesObj.A}`,
    `B：${choicesObj.B}`,
    `C：${choicesObj.C}`,
    `D：${choicesObj.D}`,
    "",
    "A / B / C / D の中からえらんでね🐻"
  ];

  return client.replyMessage(replyToken, {
    type: "text",
    text: lines.join("\n"),
    quickReply: {
      items: ["A", "B", "C", "D"].map((label) => ({
        type: "action",
        action: {
          type: "message",
          label,
          text: label,
        },
      })),
    },
  });
}

// ================================================
// Part3: メニュー表示
// ================================================
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
// Part4: 質問モード（個別指導 STEP0〜STEP4）
// ================================================

function startQuestionMode(ev) {
  const userId = ev.source.userId;

  globalState[userId] = {
    mode: "question",
    step: 0,
    question: null,
    answer: null,
    summary: null,
    choices: null,
    correct: null,
    explanation: null,
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "よし！🐻📘 今日は個別指導モードで進めるよ！\n" +
      "まずは **問題文の画像 or テキスト** を送ってね。",
  });
}

// 🎯 質問モード本体
async function handleQuestionMode(ev, state) {
  // -----------------------
  // STEP0：問題文を受け取る
  // -----------------------
  if (state.step === 0) {
    let qText = "";
    let qImage = "";

    if (ev.message.type === "image") {
      qImage = ev.message.id;
    } else if (ev.message.type === "text") {
      qText = ev.message.text.trim();
    }

    if (!qText && !qImage) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "問題文か画像が届いてないみたいだよ🐻💦\nもう一度送ってね。",
      });
    }

    state.question = { text: qText, image: qImage };
    state.step = 1;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "問題を受け取ったよ！🐻✨\n" +
        "つぎに **この問題の答え** を送ってね。\n" +
        "数学・物理・化学は答えを教えてもらえると、\nくまお先生がより正確に本質を説明できるよ！",
    });
  }

  // -----------------------
  // STEP1：答えを受け取る
  // -----------------------
  if (state.step === 1) {
    if (ev.message.type !== "text") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "答えはテキストで送ってね🐻💦",
      });
    }

    state.answer = ev.message.text.trim();
    state.step = 2;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "ありがとう！🐻✨\n" +
        "じゃあまずはこの問題が **何をきいているのか？** を確認する4択を作るね。",
    });
  }

  // -----------------------
  // STEP2：問題の意図 4択
  // -----------------------
  if (state.step === 2) {
    const positions = ["A", "B", "C"];
    const correctPos = positions[Math.floor(Math.random() * 3)];

    const prompt = `
あなたは生徒に寄り添うスーパー全科目先生くまおです。
次の問題が「何を聞いているか」を確認する4択問題を作ります。

【条件】
- A/B/C の文章は淡々と統一。
- 正解は "${correctPos}"。
- 残りの2つは
    - 1つは「ちょい惑わせ」よくある誤解
    - 1つは「ひっかけ」少し難しめの誤答
- D は必ず「もっと詳しく教えて！」にする。

【出力形式（JSONのみ）】
{
 "summary": "問題の意図をやさしく一文で説明",
 "choices": {
   "A": "〜〜〜（淡々）",
   "B": "〜〜〜（淡々）",
   "C": "〜〜〜（淡々）",
   "D": "もっと詳しく教えて！"
 },
 "correct": "${correctPos}"
}

問題文：
${state.question.text || "[画像の問題]"}

生徒の答え：
${state.answer}
`;

    const res = await openaiChat(prompt);

    let ai;
    try {
      ai = JSON.parse(res);
    } catch (e) {
      console.error("STEP2 JSON parse error:", e, res);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "ごめんね💦 4択をうまく作れなかったみたい…もう一度送ってくれる？🐻",
      });
    }

    state.summary = ai.summary;
    state.choices = ai.choices;
    state.correct = ai.correct;
    state.step = 3;

    return flexChoiceMessage(ev.replyToken, ai.summary, ai.choices);
  }

  // -----------------------
  // STEP3：4択の回答 → 解説
  // -----------------------
  if (state.step === 3) {
    if (ev.message.type !== "text") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "A / B / C / D の中からえらんでね🐻📘",
      });
    }

    const choice = ev.message.text.trim().toUpperCase();
    if (!["A", "B", "C", "D"].includes(choice)) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "A / B / C / D で答えてね🐻",
      });
    }

    // 正解 → 通常くまお解説
    if (choice === state.correct) {
      const explanation = await openaiChat(`
あなたは優しく寄り添う「くまお先生」です。
次の問題について、生徒が本質的に理解できるように、短く丁寧に解説してください。

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}

トーン：
- 優しく
- 生徒をほめる
- 無駄に長くしない
`);
      state.explanation = explanation;
      state.step = 4;

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          explanation +
          "\n\n🐻✨ いいね！\n最後にまとめと、1問だけ類題を出すね📘",
      });
    }

    // D → スーパーくまお先生
    if (choice === "D") {
      const superExplain = await openaiChat(`
あなたは「スーパーくまお先生」です。
生徒が「もっと詳しく教えて！」と言っています。
できるだけやさしく、かみ砕いて、本質をていねいに説明してください。

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
          "\n\n🐻💛 その調子だよ！\n最後にまとめと、似た問題を1問だけ出してみるね📘",
      });
    }

    // 不正解 → スーパーくまお先生
    const wrongExplain = await openaiChat(`
あなたは「スーパーくまお先生」です。
生徒が4択問題を間違えてしまいました。
落ち込ませず、やさしく丁寧に、本質をかみ砕いて説明してください。

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}

正しい考え方と、なぜ間違えやすいのかも説明してください。
`);
    state.explanation = wrongExplain;
    state.step = 4;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        wrongExplain +
        "\n\n🐻💛 大丈夫だよ！\n最後にまとめと、似た問題を1問だけ出してみるね📘",
    });
  }

  // -----------------------
  // STEP4：まとめ＋類題（4択なし）
  // -----------------------
  if (state.step === 4) {
    const prompt = `
あなたは優しく寄り添う「くまお先生」です。
次の情報をもとに、「まとめ」と「類題（4択なし）」を作ってください。

【出力形式（JSONのみ）】
{
 "summary": "今日のポイントをやさしくまとめた文章",
 "related": {
   "question": "類題の問題文（少し設定を変える）",
   "explanation": "類題の解説。ステップごとにわかりやすく。",
   "answer": "類題の答え"
 }
}

問題文：
${state.question.text || "[画像]"}

生徒の答え：
${state.answer}

これまでの解説：
${state.explanation}
`;

    const res = await openaiChat(prompt);

    let ai;
    try {
      ai = JSON.parse(res);
    } catch (e) {
      console.error("STEP4 JSON parse error:", e, res);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "ごめんね💦 類題をうまく作れなかったみたい…また問題を送ってくれる？🐻",
      });
    }

    // リセット
    state.step = 0;
    state.choices = null;
    state.correct = null;

    const msg =
      `📘 **まとめ**\n${ai.summary}\n\n` +
      `📘 **類題**\n${ai.related.question}\n\n` +
      `📘 **解説**\n${ai.related.explanation}\n\n` +
      `【答え】${ai.related.answer}\n\n` +
      "🐻✨ よく頑張ったね！\nまた別の問題も送ってみる？";

    return client.replyMessage(ev.replyToken, { type: "text", text: msg });
  }
}

// ================================================
// Part5: 講義モード（科目＋単元 → ノート講義 → 自由対話）
// ================================================

async function startLectureMode(ev) {
  const userId = ev.source.userId;

  // モード初期化
  globalState[userId] = {
    mode: "lecture",
    step: 0,
    subject: "",
    unit: "",
    lectureNote: ""
  };

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "よ〜し、授業モードに入るよ🐻📘✨\n" +
      "まずは **科目** を教えてね！\n例：数学 / 物理 / 化学 / 英語 / 国語 / 社会"
  });
}


// 🎯 講義モード本体（自由対話型）
async function handleLectureMode(ev, state) {
  const msg = ev.message.text.trim();
  const userId = ev.source.userId;

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
        "つぎは **単元（テーマ）** を教えてね。\n例：因数分解 / 波動 / 酸塩基 / 文法 / 古文読解 …"
    });
  }

  // ------------------------------
  // STEP1：単元を受け取る → 講義スタート
  // ------------------------------
  if (state.step === 1) {
    state.unit = msg;
    state.step = 2;

    // GPT に講義ノートを生成させる
    const lecture = await openaiChat(`
あなたは優しく丁寧で、生徒のやる気を引き出す「くまお先生」です。

【目的】
生徒がノートにまとめやすい、体系的でわかりやすい講義をする。

【講義の条件】
- 見出し → ポイント → 例 の順に整理
- 数式や図解イメージの言語化OK
- 難しい部分は必ず噛み砕く
- くまお先生の温かい雰囲気
- 長すぎず、しかし内容は充実させる

【出力形式】
講義ノートのみ（Markdown不要）

科目：${state.subject}
単元：${state.unit}
    `);

    state.lectureNote = lecture;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "📘 **くまお先生の講義ノート**\n\n" +
        lecture +
        "\n\n🐻✨ ここまでどうかな？\n気になるところを質問してくれたら、なんでも深掘りして説明するよ！\n\n" +
        "・わからないところを聞く\n" +
        "・別の例を見たい\n" +
        "・さらに難しい内容を知りたい\n" +
        "・演習したい！\n" +
        "・メニュー\n"
    });
  }

  // ------------------------------
  // STEP2：自由対話フェーズ（永続ステップ）
  // ------------------------------
  if (state.step === 2) {

    // ✨ メニューへ戻る
    if (msg === "メニュー") {
      globalState[userId] = { mode: "menu" };
      return replyMenu(ev.replyToken);
    }

    // ✨ 別の単元
    if (msg === "別の単元") {
      state.step = 1;
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "OK！🐻✨ 新しい単元を教えてね！"
      });
    }

    // ✨ 演習したい
    if (msg === "演習したい！") {
      return startExerciseMode(ev);
    }

    // ✨ 生徒が質問 → 深掘り解説
    const deeper = await openaiChat(`
あなたは「くまお先生」です。
以下の講義内容を踏まえ、 生徒の質問に対して
・丁寧に
・わかりやすく
・寄り添って
・必要なら例や図解を加えて
説明してください。

講義ノート：
${state.lectureNote}

生徒の質問：
${msg}

出力：説明テキストのみ
    `);

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        deeper +
        "\n\n🐻✨ 他にも知りたいところがあれば、何でも聞いてね！\n\n" +
        "・別の単元\n・演習したい！\n・メニュー"
    });
  }
}

// ================================================
// Part6: 演習モード（1問 → 解答 → くまお判定）
// ================================================

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
      "よし！🐻🔥 演習モードにはいったよ！\n" +
      "まずは軽くウォーミングアップ問題を1問出すね。\n" +
      "準備できたら「OK」と送ってね📘",
  });
}

// 🎯 演習モード本体
async function handleExerciseMode(ev, state) {
  const msg = ev.message.type === "text" ? ev.message.text.trim() : "";

  // STEP0：準備OK → 問題出題
  if (state.step === 0) {
    if (msg !== "OK") {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "準備できたら「OK」と送ってね🐻📘",
      });
    }

    const q = await openaiChat(`
あなたは「くまお先生」です。
中学生〜高校生向けの数学・物理・化学からランダムに1問だけ演習問題を作ってください。

【条件】
- 短く明確
- 計算問題でも文章問題でもOK
- 出力は問題文のみ（解説や答えは書かない）

出力：問題文のみ
`);

    state.question = q;
    state.step = 1;

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "📘 **演習問題**\n" +
        q +
        "\n\n解けたら答えを送ってね🐻",
    });
  }

  // STEP1：回答受信 → 判定へ
  if (state.step === 1) {
    state.answer = msg;
    state.step = 2;
    return checkExerciseAnswer(ev, state);
  }

  // STEP2 で何か来たら、とりあえずもう1問の希望を聞く
  if (state.step === 2) {
    if (msg === "もう1問！") {
      state.step = 0;
      return handleExerciseMode(ev, state);
    }
    if (msg === "難しめに挑戦！") {
      // ちょい難しめ指示
      state.step = 0;
      const q = await openaiChat(`
あなたは「くまお先生」です。
少し難しめ（標準〜難）の中高生向け数学・物理・化学の問題を1問だけ作ってください。

【条件】
- 思考力がいる問題
- 出力は問題文のみ

出力：問題文のみ
`);
      state.question = q;
      state.step = 1;

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text:
          "🔥 ちょい難しめの問題いくよ！\n\n" +
          "📘 **演習問題**\n" +
          q +
          "\n\n解けたら答えを送ってね🐻",
      });
    }
    if (msg === "メニュー") {
      globalState[ev.source.userId] = { mode: "menu" };
      return replyMenu(ev.replyToken);
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "どうする？\n・「もう1問！」\n・「難しめに挑戦！」\n・「メニュー」",
    });
  }
}

// 判定＋解説
async function checkExerciseAnswer(ev, state) {
  const evaluation = await openaiChat(`
あなたは「くまお先生」です。
生徒の回答が正しいかどうかを判定してコメントしてください。

【出力形式（JSONのみ）】
{
 "correct": true or false,
 "explanation": "くまお先生の優しい解説（正解時は短く褒める、誤答時はスーパーくまお先生モードで丁寧に）"
}

問題：
${state.question}

生徒の答え：
${state.answer}
`);

  let ai;
  try {
    ai = JSON.parse(evaluation);
  } catch (e) {
    console.error("exercise JSON error:", e, evaluation);
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "判定がちょっと乱れちゃった💦 もう一度答えを送ってもらえる？🐻",
    });
  }

  state.step = 2;

  if (ai.correct) {
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "💮 **正解！すばらしい！**\n\n" +
        ai.explanation +
        "\n\n次はどうする？\n・「もう1問！」\n・「難しめに挑戦！」\n・「メニュー」",
    });
  }

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      "🐻💛 だいじょうぶだよ。\n間違えるのは成長のチャンスなんだよ。\n\n" +
      ai.explanation +
      "\n\nどうする？\n・「もう1問！」\n・「難しめに挑戦！」\n・「メニュー」",
  });
}

// ================================================
// Part7: 画像処理 & 通常質問
// ================================================

// 画像処理
async function handleImage(ev) {
  const stream = await client.getMessageContent(ev.message.id);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");

  const system = buildSystemPrompt("image");
  const prompt = [
    "画像の数学問題を読み取り、手順を説明し、最後に【答え】を一行で書いてください。",
    "数式は LINE 向けに (a)/(b), √(), x^n などで表現すること。",
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

// 通常の質問（どのモードでもないとき）
async function handleGeneralQuestion(ev) {
  const text = ev.message.text.trim();
  const system = buildSystemPrompt("text");

  const response = await openaiChat([
    { role: "system", content: system },
    { role: "user", content: buildGeneralPrompt(text) },
  ]);

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: withKumaoHighlights(sanitize(response)),
  });
}

// Postback（今は特別な処理なし）
async function handlePostback(ev) {
  return client.replyMessage(ev.replyToken, {
    type: "text",
    text: "ボタンを押してくれてありがとう🐻",
  });
}

// ================================================
// Part8: メインイベントルーター
// ================================================
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!globalState[userId]) {
    globalState[userId] = { mode: "menu" };
  }
  const state = globalState[userId];

  // Postback
  if (event.type === "postback") {
    return handlePostback(event);
  }

  // メッセージ
  if (event.type === "message") {
    const msgType = event.message.type;

    // 画像
    if (msgType === "image") {
      // 質問モード中なら、そのまま質問モードに渡す
      if (state.mode === "question") {
        return handleQuestionMode(event, state);
      }
      // それ以外は通常の画像解析
      return handleImage(event);
    }

    // テキスト
    if (msgType === "text") {
      const text = event.message.text.trim();

      // いつでも「メニュー」で戻せる
      if (text === "メニュー") {
        globalState[userId] = { mode: "menu" };
        return replyMenu(event.replyToken);
      }

      // モード未設定 or menu
      if (!state.mode || state.mode === "menu") {
        if (text === "質問したいよ〜🐻") {
          return startQuestionMode(event);
        }
        if (text === "授業をうけたいな✨") {
          return startLectureMode(event);
        }
        if (text === "演習したい！") {
          return startExerciseMode(event);
        }

        // 上記以外 → メニュー表示
        globalState[userId] = { mode: "menu" };
        return replyMenu(event.replyToken);
      }

      // 既にどれかのモード中
      if (state.mode === "question") {
        return handleQuestionMode(event, state);
      }
      if (state.mode === "lecture") {
        return handleLectureMode(event, state);
      }
      if (state.mode === "exercise") {
        return handleExerciseMode(event, state);
      }

      // 想定外 → 通常質問
      return handleGeneralQuestion(event);
    }
  }

  // その他
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "メッセージを受け取ったよ🐻",
  });
}

// ================================================
// Part9: 起動
// ================================================
const PORT = process.env.PORT || 8880;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🧪 StudyEye LINE Bot Running on port ${PORT}`);
});
