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
   表示文言（ここ以外からユーザー文言を出さない）
   ※ 文言を変更する時は、必ずあなたの許可を得てからここだけ変更
===================== */
const COPY = {
  MENU: "こんにちは🐻✨\n\n今日は何をする？\n① 質問がしたい\n② 講義を受けたい\n③ 演習がしたい\n④ 雑談がしたい",
  ENTER_QUESTION: "質問モードだよ🐻✨\n文章で質問してもOK。\n画像で送っても大丈夫だよ。",
  ENTER_LECTURE: "講義モードだよ🐻✨\n\nどの教科・単元の講義を受けたい？\n例：二次関数 最大値 / 鎌倉時代 幕府 / 化学 酸と塩基",
  ENTER_PRACTICE: "演習モードだよ🐻✨\n\nどの教科・単元で練習する？\n例：二次関数 最大値 / 鎌倉時代 幕府 / 化学 酸と塩基",
  ENTER_CHAT: "雑談モードだよ🐻✨\nなんでも話してね😊",

  AFTER_QUESTION:
    "ほかに聞きたいことある？\nそれとも、この問題の類題を解いてみる？\n\n類題を解くなら、\n・時代\n・人物\n・場所\nを一言で教えてね🐻✨",

  IMG_RECEIVED:
    "画像を受け取ったよ🐻✨\n\nこの問題の公式の答えがあれば送ってね。\nなければ「答えなし」で大丈夫だよ。",

  PRACTICE_CONDITION_NUDGE:
    "いいね🐻✨\n\n類題を作るよ。\n時代・人物・場所（または単元）を一言で教えてね😊",

  PRACTICE_ANSWER_OK: "答えだけ送っても大丈夫だよ😊",

  LECTURE_OFFER:
    "だいじょうぶだよ😊\nここが一番の伸びポイントだね🐻✨\n\nじゃあ、このテーマの講義を受ける？\n・はい\n・いいえ",

  CORRECT: "いいね！正解だよ🐻✨",
  INCORRECT: "惜しい！でも大丈夫🐻✨",

  NEXT_CHOICE: "このあとどうする？\n・もう1問、類題\n・質問に戻る",

  OK_CONTINUE: "OK😊 じゃあ続けよう！",

  ASK_SEND_ANSWER: "公式の答えがあれば送ってね。なければ「答えなし」でOKだよ😊",
};

/* =====================
   ユーザー状態
===================== */
const userState = {};
/*
mode:
menu
question_text
after_question
image_waiting_answer
practice_condition
practice_waiting_answer
lecture_condition
lecture_mode
chat_mode
lecture_offer

memory:
lastQuestionText (直前のユーザー質問のテキスト or 画像質問の説明文)
lastExplanation (直前の解説全文)
exerciseQuestion
practiceSubject
practiceConditionText
lectureConditionText
*/

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
    } catch (e) {
      console.error(e);
      res.status(200).end();
    }
  }
);

/* =====================
   メイン処理
===================== */
async function handleEvent(event) {
  const userId = event.source.userId;
  if (!userState[userId]) userState[userId] = { mode: "menu" };

  /* -------- 画像 -------- */
  if (event.message?.type === "image") {
    userState[userId] = {
      mode: "image_waiting_answer",
      imageId: event.message.id,
      // lastQuestionText は画像そのものなので、説明文はあとで生成される解説結果を採用
    };

    return reply(event.replyToken, COPY.IMG_RECEIVED);
  }

  /* -------- テキスト以外は無視 -------- */
  if (event.message?.type !== "text") return;
  const text = event.message.text.trim();

  /* ===== メニュー呼び出し（いつでも） ===== */
  if (text === "メニュー" || text === "menu" || text === "MENU") {
    userState[userId] = { mode: "menu" };
    return reply(event.replyToken, COPY.MENU);
  }

  /* ===== 画像の答え待ち ===== */
  if (userState[userId]?.mode === "image_waiting_answer") {
    const imageId = userState[userId].imageId;
    const officialAnswer =
      text === "答えなし" || text === "なし" ? null : text;

    const base64 = await getImageBase64(imageId);
    const result = await runVisionQuestionMode(base64, officialAnswer);

    userState[userId] = {
      mode: "after_question",
      lastQuestionText: "（画像の問題）",
      lastExplanation: result,
    };

    return reply(event.replyToken, result);
  }

  /* ===== メニュー状態 ===== */
  if (userState[userId]?.mode === "menu") {
    if (text === "①" || text.includes("質問")) {
      userState[userId] = { mode: "question_text" };
      return reply(event.replyToken, COPY.ENTER_QUESTION);
    }
    if (text === "②" || text.includes("講義")) {
      userState[userId] = { mode: "lecture_condition" };
      return reply(event.replyToken, COPY.ENTER_LECTURE);
    }
    if (text === "③" || text.includes("演習") || text.includes("練習")) {
      userState[userId] = { mode: "practice_condition" };
      return reply(event.replyToken, COPY.ENTER_PRACTICE);
    }
    if (text === "④" || text.includes("雑談")) {
      userState[userId] = { mode: "chat_mode" };
      return reply(event.replyToken, COPY.ENTER_CHAT);
    }

    // 想定外入力：メニューを再提示（文言は固定）
    return reply(event.replyToken, COPY.MENU);
  }

  /* ===== 質問モード（文章） ===== */
  if (userState[userId]?.mode === "question_text") {
    // 「①」「質問」などを打ち直してもOK
    if (text === "①" || text === "質問") {
      return reply(event.replyToken, COPY.ENTER_QUESTION);
    }

    const result = await runTextQuestionMode(text);

    userState[userId] = {
      mode: "after_question",
      lastQuestionText: text,
      lastExplanation: result,
    };

    return reply(event.replyToken, result);
  }

  /* ===== 解説後（after_question） ===== */
  if (userState[userId]?.mode === "after_question") {
    // 類題へ
    if (text.includes("類題") || text.includes("練習") || text === "③") {
      userState[userId].mode = "practice_condition";
      return reply(event.replyToken, COPY.PRACTICE_CONDITION_NUDGE);
    }

    // 講義へ
    if (text.includes("講義") || text === "②") {
      userState[userId].mode = "lecture_condition";
      return reply(event.replyToken, COPY.ENTER_LECTURE);
    }

    // 雑談へ
    if (text.includes("雑談") || text === "④") {
      userState[userId].mode = "chat_mode";
      return reply(event.replyToken, COPY.ENTER_CHAT);
    }

    // 追加質問（そのまま質問として処理）
    userState[userId].mode = "question_text";
    return reply(event.replyToken, "OK😊 そのまま質問してね。");
  }

  /* ===== 演習：条件入力 ===== */
  if (userState[userId]?.mode === "practice_condition") {
    const subject = detectSubjectFromCondition(text);

    const prompt = getExercisePrompt(subject);
    // 類題生成は「直前の問題」を元にする（仕様書の方針）
    // lastQuestionText がない場合は条件テキストを補助として渡す
    const base = userState[userId].lastQuestionText || "（直前問題なし）";
    const conditionHint = text;

    const question = await callOpenAI([
      { role: "system", content: prompt },
      {
        role: "user",
        content:
          "直前の問題:\n" +
          base +
          "\n\n条件（生徒指定）:\n" +
          conditionHint +
          "\n\n条件に沿って類題を1問だけ作ってください。",
      },
    ]);

    userState[userId] = {
      ...userState[userId],
      mode: "practice_waiting_answer",
      exerciseQuestion: question,
      practiceSubject: subject,
      practiceConditionText: text,
    };

    return reply(
      event.replyToken,
      "【類題】\n" + question + "\n\n" + COPY.PRACTICE_ANSWER_OK
    );
  }

  /* ===== 演習：判定 ===== */
  if (userState[userId]?.mode === "practice_waiting_answer") {
    // 生徒が「わからない」系
    if (text.includes("分から") || text.includes("わから") || text === "無理") {
      userState[userId].mode = "lecture_offer";
      return reply(event.replyToken, COPY.LECTURE_OFFER);
    }

    const judge = await judgeAnswerLoose(
      userState[userId].exerciseQuestion,
      text
    );

    if (judge === "正解") {
      userState[userId].mode = "after_question";
      return reply(
        event.replyToken,
        COPY.CORRECT + "\n\n" + COPY.AFTER_QUESTION
      );
    } else {
      userState[userId].mode = "lecture_offer";
      return reply(event.replyToken, COPY.INCORRECT + "\n\n" + COPY.LECTURE_OFFER);
    }
  }

  /* ===== 講義提案（はい／いいえ） ===== */
  if (userState[userId]?.mode === "lecture_offer") {
    if (text === "はい" || text === "うん" || text === "受ける") {
      userState[userId].mode = "lecture_mode";
      // 講義本文は後フェーズ：今は安全な枠だけ出す
      const lecture = getLectureSkeleton(userState[userId].practiceConditionText);
      userState[userId].mode = "after_question";
      return reply(event.replyToken, lecture + "\n\n" + COPY.AFTER_QUESTION);
    }

    // いいえ → 演習に戻す or after_questionへ
    userState[userId].mode = "after_question";
    return reply(event.replyToken, COPY.OK_CONTINUE + "\n\n" + COPY.AFTER_QUESTION);
  }

  /* ===== 講義：条件入力 ===== */
  if (userState[userId]?.mode === "lecture_condition") {
    // 今は講義中身は後フェーズ：枠だけ出す（安全）
    const lecture = getLectureSkeleton(text);

    userState[userId] = {
      ...userState[userId],
      mode: "after_question",
      lectureConditionText: text,
    };

    return reply(event.replyToken, lecture + "\n\n" + COPY.AFTER_QUESTION);
  }

  /* ===== 雑談モード ===== */
  if (userState[userId]?.mode === "chat_mode") {
    // 雑談は軽く返しつつ、いつでも学習に戻れる導線
    const replyText =
      "うんうん😊\n" +
      "話してくれてありがとう🐻✨\n\n" +
      "勉強に戻したくなったら\n「メニュー」って送ってね。";
    return reply(event.replyToken, replyText);
  }

  /* ===== どれにも当てはまらない場合 ===== */
  userState[userId].mode = "menu";
  return reply(event.replyToken, COPY.MENU);
}

/* =====================
   教科判定（条件入力向け）
===================== */
function detectSubjectFromCondition(text) {
  // 数学っぽい
  if (text.match(/[0-9]/) || text.includes("関数") || text.includes("微分") || text.includes("積分")) return "math";
  // 理科っぽい
  if (text.includes("物理") || text.includes("化学") || text.includes("電流") || text.includes("力") || text.includes("酸") || text.includes("塩基")) return "science";
  // 歴史っぽい
  if (text.includes("時代") || text.includes("天皇") || text.includes("幕府") || text.includes("戦争") || text.includes("世界史") || text.includes("日本史")) return "history";
  // 英語っぽい
  if (text.match(/[a-zA-Z]/) || text.includes("英文法")) return "english";
  return "general";
}

/* =====================
   類題プロンプト（仕様書寄り：答え・解説なし／構造固定）
===================== */
function getExercisePrompt(subject) {
  // 仕様書：数学・理科は「構造同一」「数値のみ変更」寄り
  if (subject === "math" || subject === "science") {
    return `
あなたは「くまお先生」🐻✨
直前の問題と全く同じ構造・同じ解き方で、数字や条件だけを変えた類題を1問作ってください。

条件：
・文章構造を変えない
・解法を変えない
・答えや解説は書かない
・問題文のみを書く
・余計な前置きは書かない
`;
  }

  // 仕様書：社会（歴史・公民）は「指定条件に必ず限定」「飛ばない」
  if (subject === "history") {
    return `
あなたは「くまお先生」🐻✨
直前の問題と同じ問い方・同じ構造で、指定された「時代・人物・場所（またはテーマ）」に必ず限定した類題を1問作ってください。

条件：
・指定条件から外れない（別時代・別テーマへ飛ばない）
・問いの形式を変えない
・答えや解説は書かない
・問題文のみを書く
・余計な前置きは書かない
`;
  }

  // 将来拡張（国語・英語）
  if (subject === "english") {
    return `
あなたは「くまお先生」🐻✨
直前の問題と同じ文法・同じ形式で、語彙や文だけを変えた類題を1問作ってください。

条件：
・形式と狙いは同じ
・答えや解説は書かない
・問題文のみを書く
・余計な前置きは書かない
`;
  }

  return `
あなたは「くまお先生」🐻✨
直前の問題と同じ形式で、内容を少しだけ変えた類題を1問作ってください。
答えや解説は書かず、問題文だけを書いてください。
余計な前置きは書かないでください。
`;
}

/* =====================
   質問モード（文章）— 仕様書の解説フォーマット遵守
===================== */
async function runTextQuestionMode(text) {
  const prompt = `
あなたは「くまお先生」🐻✨
中学生〜高校生に向けて、黒板の板書みたいに整理して説明してください。
難しい専門用語は使わないでください。

書式ルール：
・Markdown記号は禁止
・LaTeX記号は禁止
・太字、斜体、装飾禁止
・使ってよい記号：× − ²
・同じ式を繰り返さない
・数式は見やすさ最優先

構成（固定）：
【問題の要点】
どんな問題かを一文で説明（絵文字OK）

【解き方】
1⃣
2⃣
3⃣
必要なら4⃣、5⃣まで可

【解説】
先生が黒板で説明するように「今、何をしているか」が分かる説明

【答え】
答えのみを明確に表示

最後に必ず以下をそのまま出力する：
${COPY.AFTER_QUESTION}
`;

  return callOpenAI([
    { role: "system", content: prompt },
    { role: "user", content: text },
  ]);
}

/* =====================
   Vision質問（画像）— 仕様書の解説フォーマット遵守
===================== */
async function runVisionQuestionMode(imageBase64, officialAnswer) {
  const prompt = `
あなたは「くまお先生」🐻✨
中学生〜高校生に向けて、黒板の板書みたいに整理して説明してください。
難しい専門用語は使わないでください。

書式ルール：
・Markdown記号は禁止
・LaTeX記号は禁止
・太字、斜体、装飾禁止
・使ってよい記号：× − ²
・同じ式を繰り返さない
・数式は見やすさ最優先

構成（固定）：
【問題の要点】
【解き方】
1⃣
2⃣
3⃣
【解説】
【答え】

最後に必ず以下をそのまま出力する：
${COPY.AFTER_QUESTION}
`;

  return callOpenAI([
    { role: "system", content: prompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: officialAnswer
            ? `公式の答えは「${officialAnswer}」です。`
            : "公式の答えはありません。",
        },
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
        },
      ],
    },
  ]);
}

/* =====================
   演習判定（安全：正解/不正解だけ返させる）
===================== */
async function judgeAnswerLoose(question, answer) {
  const res = await callOpenAI([
    {
      role: "system",
      content:
        "次の問題と答えを見て、正しければ「正解」、違えば「不正解」だけを書いてください。余計な文章は禁止。",
    },
    { role: "user", content: `問題:\n${question}\n\n答え:\n${answer}` },
  ]);

  return res.includes("正解") ? "正解" : "不正解";
}

/* =====================
   講義（中身は後フェーズ：今は枠だけ固定）
===================== */
function getLectureSkeleton(themeText) {
  return (
    "🐻✨ くまお先生の講義\n\n" +
    "今日のテーマ：\n" +
    (themeText || "（指定なし）") +
    "\n\n" +
    "ここでは、\n" +
    "・全体像\n" +
    "・大事なポイント\n" +
    "・よく間違えるところ\n" +
    "を整理して説明するよ😊\n\n" +
    "ノートを取りながら見てね📘"
  );
}

/* =====================
   OpenAI共通
===================== */
async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages,
      temperature: 0.2,
    }),
  });

  const json = await res.json();
  if (!json?.choices?.[0]?.message?.content) {
    console.error("OpenAI error response:", json);
    return "ごめんね、今ちょっと混み合ってるみたい🐻💦\nもう一度送ってくれる？";
  }
  return json.choices[0].message.content;
}

/* =====================
   画像取得
===================== */
async function getImageBase64(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

/* =====================
   reply helper
===================== */
function reply(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: "text",
    text,
  });
}

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🐻✨ くまお先生 起動！");
});
