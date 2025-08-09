# eternal_final (くまお先生Bot 完成版)

## 機能
- テキスト質問 → OpenAI API (GPT-4o) で楽しく・やさしく・正確に解説
- 画像質問（スクショ・アルバム保存OK） → Vision APIで解析して解説
- エラー時も落ちずに自然返答
- Railwayで常駐（即停止なし）

## セットアップ
1. Node.js 18+ を用意
2. ZIP展開
3. `.env` を作成し、以下を記入
```
LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxxxxxxxxxx
LINE_CHANNEL_SECRET=xxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
```
4. 依存インストール
```
npm install
```
5. ローカル起動
```
npm start
```
→ `http://localhost:3000/healthz` にアクセスでOK確認

## Railwayデプロイ
1. プロジェクト作成 → このZIPをアップロード
2. 環境変数に `.env` の中身を登録
3. デプロイ
4. LINE DevelopersでWebhook URLを設定  
   例: `https://<railway-app-name>.up.railway.app/webhook`
5. Webhookを有効化して完了

## 注意
- Vision APIは画像サイズが大きすぎると自動縮小
- 対応メッセージタイプはテキストと画像のみ