# eternal_final_hybrid_v5（神仕様）

## できること
- くまお先生の**やさしい解説（テキスト）**
- **数式は黒板風の画像**でくっきり（シャープな数学フォント）
- **最後に【答え】** を一行で明記
- 画像問題（スクショ・アルバム保存）にも対応

## 必要な環境変数（Railway Variables）
```
CHANNEL_ACCESS_TOKEN=
CHANNEL_SECRET=
OPENAI_API_KEY=
PUBLIC_BASE_URL= https://<your-app>.up.railway.app   # 任意（未設定でも自動推定）
```

## デプロイ
```
npm i
npm start  # /healthz が 200 になればOK
```
Railwayにアップ → Variables設定 → Webhook: `https://<your-app>.up.railway.app/webhook`

## 使い方
- **テキスト質問**：解説（番号つき）＋【答え】、必要なら数式画像を添付
- **画像質問**：画像の内容を解析して、同様に解説＋数式画像＋【答え】

## メモ
- テキストにはLaTeXを使いません（読みやすい記号表記）
- 画像内の数式は内部的にLaTeXで描画（MathJax → SVG → PNG）
- 画像は `/public/boards/*.png` として配信されます