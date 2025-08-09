# eternal_final_hotfix_v3

### 変更点
- 数学表記の視認性を改善（sqrt(...) → √(...), 演算子のスペース挿入）
- くまお先生トーン強化（絵文字はほどほど）
- 必ず最後に【答え】… を1行で明記（未出時は自動付与）

### 使い方
1) Variables: CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY  
2) `npm i` → `npm start`（/healthz = 200）  
3) Webhook: `https://<app>.up.railway.app/webhook`