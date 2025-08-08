// util: ランダム文選択
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// テンプレ群（くまお先生口調）
const TEMPLATES = {
  confirm_steps: [
    "この問題、ここまでの読み取りで合ってそう？",
    "ポイントはこんな感じ。続けていい？",
    "ざっくり要点はここ！ いったんここまでどう？"
  ],
  ask_try_alone: [
    "ここからは一人でいけそう？試してみる？",
    "この先は任せてよさそう？ 2分タイマー回すよ",
    "この一手は自分で置いてみる？"
  ],
  praise: [
    "いいね👍 着眼が素晴らしい！",
    "完璧✨ その流れで合ってるよ！",
    "ナイス！筋が通ってる🧸"
  ],
  near_miss: [
    "発想は合ってる👏 この一歩だけ修正しよう（符号／式の並べ方）",
    "惜しい！ここで条件をもう1回だけ見直そう",
    "流れOK。計算のここだけ丁寧にいこう"
  ]
};

// 超小型ステート（本番はRedis推奨）
const session = new Map(); // key: userId, value: {state, payload}

function nextState(userId, intent, payload = {}) {
  const s = session.get(userId) || { state: "START", payload: {} };
  // 状態遷移
  switch (s.state) {
    case "START":
      if (intent === "IMAGE") return save("PARSE", { image: payload.image });
      if (intent === "TEXT")  return save("SOLVE_ONESHOT", { text: payload.text });
      break;
    case "PARSE":
      if (intent === "PARSE_DONE") return save("HUMAN_CHECK", { ...s.payload, parse: payload.parse });
      break;
    case "HUMAN_CHECK":
      if (intent === "YES") return save("HINT1", s.payload);
      if (intent === "NO")  return save("REVISE", s.payload);
      break;
    case "HINT1":
      if (intent === "CONTINUE") return save("HINT2", s.payload);
      break;
    case "HINT2":
      if (intent === "CONTINUE") return save("SOLUTION", s.payload);
      break;
    case "SOLUTION":
      if (intent === "ASK_TRY") return save("TRY_ALONE", s.payload);
      break;
    case "TRY_ALONE":
      if (intent === "ANSWER") return save("CHECK_ANSWER", { ...s.payload, answer: payload.answer });
      break;
    case "CHECK_ANSWER":
      if (intent === "CORRECT") return save("PRAISE", s.payload);
      if (intent === "WRONG")   return save("RETEACH", s.payload);
      break;
  }
  return s;

  function save(state, p) {
    const ns = { state, payload: p };
    session.set(userId, ns);
    return ns;
  }
}

// 応答生成の骨子（自然文を差し込む）
async function respond(userId, event, nlp) {
  const { type, text, imageContent } = event; // 既存の取得ロジックを想定
  let st;

  if (imageContent) {
    st = nextState(userId, "IMAGE", { image: imageContent });
    // 画像解析（切り出し→要点要約）
    const parse = await parseImageToKeypoints(imageContent); // 既存/外部関数
    st = nextState(userId, "PARSE_DONE", { parse });
    return [
      msg(formatKeypoints(parse)),
      msg(pick(TEMPLATES.confirm_steps)) // ← 人間チェック
    ];
  }

  // “はい/いいえ” のゆる判定（YES/NO）
  if (isYes(text)) {
    st = nextState(userId, "YES");
    if (st.state === "HINT1") {
      return [
        msg(await hint1(st.payload)),
        msg("続けようか？（OKで進むよ）")
      ];
    }
  }
  if (isNo(text)) {
    st = nextState(userId, "NO");
    return [msg("よし修正するね。どの部分が違いそう？（条件／図形／式）")];
  }

  // 進行キーワード
  if (/OK|おけ|続け/i.test(text)) {
    st = nextState(userId, "CONTINUE");
    if (st.state === "HINT2") {
      return [msg(await hint2(st.payload)), msg("もう一歩いこう。OKなら続けるよ")];
    }
    if (st.state === "SOLUTION") {
      const sol = await solution(st.payload);
      const ask = pick(TEMPLATES.ask_try_alone);
      // ここで短く区切って送信（LINEの文字数・自然さ対策）
      return [msg(sol.header), msg(sol.steps), msg("ここで区切るね🐾"), msg(ask)];
    }
  }

  // 自力回答がきた場合（数式/数値っぽい）
  if (looksLikeAnswer(text)) {
    st = nextState(userId, "ANSWER", { answer: text });
    const ok = await checkAnswer(st.payload);
    st = nextState(userId, ok ? "CORRECT" : "WRONG");
    if (st.state === "PRAISE") return [msg(pick(TEMPLATES.praise)), msg("仕上げに別解も見てみる？")];
    if (st.state === "RETEACH") return [msg(pick(TEMPLATES.near_miss)), msg(await microReteach(st.payload))];
  }

  // テキスト一発解説の入口
  if (type === "text") {
    const once = await oneshotExplain(text);
    return [msg(once.summary), msg(once.nextStep)];
  }

  // フォールバック
  return [msg("うん、情報がもう一息ほしい🧸 画像か問題文を送ってくれる？")];
}

// 小物ユーティリティ（ダミー/既存差し替え）
const isYes = (t) => /^(はい|ok|おけ|了解|大丈夫)/i.test(t?.trim());
const isNo  = (t) => /^(いいえ|違う|まて|ちがう)/i.test(t?.trim());
const looksLikeAnswer = (t) => /[0-9x=+\-*/^()]/.test(t || "");
const msg = (t) => ({ type: "text", text: t });
