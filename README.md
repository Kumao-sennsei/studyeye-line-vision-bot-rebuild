# Kumao LINE Bot (Accurate + Random Prompts)
- ✍️ TEXT: くまお先生が **やさしく詳しく** 一発回答（要約→解き方→【答え】）。正確さ重視。
- 📸 IMAGE: **段階対話**（要約→待つ→解き方→待つ→答え）。
  - 「無理/できない/ヒント」でヒント返答＆待機
  - 生徒の答えを判定（±1% or ±0.01）→ 正解はほめる／不正解はやさしく訂正
  - 問いかけは **ランダム文言**（3パターン）で自然な会話感を演出
- 数式は **Unicode強化**（√, ², ×, ≤ など）＆ **LaTeX記法は禁止・除去**。

## Setup
1) Node.js 18+
2) `npm install`
3) `.env` を作成しキー設定（.env.example参照）
4) `npm start`

## Railway
- Variables: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY
- Webhook: `https://<railway-app>/webhook`
