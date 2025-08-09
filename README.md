# eternal_v2 (Railway 最小構成)

Railway で「Starting Container → Stopping Container」と即停止する問題を解消するための最小サーバー。  
`process.env.PORT` を listen しつづける **常駐プロセス** を提供します。

## ローカル実行 (Windows 10)

```bash
# Node.js 18+ が必要です
npm i
npm start
# -> http://localhost:3000 で "Kumao bot is running!" が表示
# -> http://localhost:3000/healthz で {"ok": true} が返る
```

## Railway デプロイ手順

1. プロジェクトにこの ZIP をアップロードして展開 or GitHub にプッシュ
2. Railway の Service を作成（Node.js）
3. 環境変数は不要（PORT は Railway が自動で注入）
4. **Start Command** は `npm start`（package.json に設定済み）
5. デプロイ後、Logs に `Server is listening on port ...` が出れば成功  
   `/healthz` にアクセスして 200 が返れば OK

## よくある落ちポイント
- `package.json` に `"start"` が無い → Railway が何も起動できず停止
- `process.env.PORT` を listen していない → ヘルスチェック失敗で停止
- サーバーが常駐しないスクリプト構成 → 実行直後に終了

## 構成
- `index.js` … Express 常駐サーバー
- `package.json` … `npm start` 定義 & 依存関係