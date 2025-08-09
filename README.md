# eternal_final_hotfix_v2

### 追加点
- くまお先生の口調（やさしく面白くわかりやすく、絵文字ほどほど）を強化
- **最後に必ず「【答え】…」を明記**（未出時はワンライン要約を自動付与）
- **LaTeX禁止**の数式整形（sqrt(), x^2, ∫ f(x) dx, a/b など）

### 必要な環境変数（Railway Variables）
```
CHANNEL_ACCESS_TOKEN=
CHANNEL_SECRET=
OPENAI_API_KEY=
```
（互換: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET も読めます）

### デプロイ
1) 依存: `npm i`  
2) 起動: `npm start` → `/healthz` = 200  
3) Webhook: `https://<your-app>.up.railway.app/webhook`