
# eternal_final_science_v6（最終完成形）

## 特徴
- **LINEで崩れない数式・理科記号**（LaTeXは禁止し、Unicode/読みやすい記号に自動整形）
- **必要時のみ黒板画像**：<LATEX> ... </LATEX> があると、その部分だけ黒板PNGを生成して添付
- **くまお先生口調**で段階的に解説、最後は必ず **【答え】一行**
- 物理/化学/生物の単位・ギリシャ文字もOK（Ω, µ, Δ, θ, λ, °C など）

## 環境変数（Railway Variables）
```
CHANNEL_ACCESS_TOKEN=
CHANNEL_SECRET=
OPENAI_API_KEY=
PUBLIC_BASE_URL=https://<your-app>.up.railway.app  # 任意（推奨）
```

## デプロイ
```
npm i
npm start  # /healthz が 200 ならOK
```
Webhook: `https://<your-app>.up.railway.app/webhook`

## 使い方
- 通常は**テキストだけ**で読みやすく返答
- 複雑な式がある場合、回答の最後に **<LATEX> ... </LATEX>** を付けるようプロンプト済み → 黒板画像が自動添付
