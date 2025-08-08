# StudyEye LINE Vision Bot (Rebuild)

画像で送られた学習の質問を OpenAI に解析させ、解説文を LINE に返信します。
2025-07-17 に動いていた機能を最短で再現するための **最小構成** です。

## セットアップ

1) Node.js 18+ を用意
2) このリポジトリを解凍
3) 依存関係をインストール:
   ```bash
   npm install
   ```
4) 環境変数ファイルを作成:
   ```bash
   cp .env.example .env
   # .env を開き、以下をセット
   # CHANNEL_ACCESS_TOKEN=
   # CHANNEL_SECRET=
   # OPENAI_API_KEY=
   ```

## ローカル起動
```bash
npm start
# http://localhost:3000
```

## Webhook 設定（LINE Developers）
- Messaging API チャネルを作成済みであること（公式アカウントの審査は未承認でも開発は可能）
- Webhook URL: `https://<あなたのサーバー>/webhook`
- Webhook の利用: 有効
- 「チャネルアクセストークン（長期）」と「チャネルシークレット」を取得し .env に設定

### ngrok 等でローカルを公開する場合
```bash
ngrok http 3000
# 生成された https URL を Webhook に設定
```

## 動作
- 画像メッセージ: 画像を取得 → OpenAI Vision (gpt-4o-mini) で解析 → 解説テキストを返信
- テキストメッセージ: 直接 OpenAI に投げて解説を返信

## デプロイ例（Railway）
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: Node 18, `.env` を環境変数に
