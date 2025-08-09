# eternal_final_hotfix

環境変数名を **CHANNEL_ACCESS_TOKEN / CHANNEL_SECRET / OPENAI_API_KEY** に合わせた版。  
（互換として LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET も読めます）

## セットアップ
1) `.env` に下記を記入
```
CHANNEL_ACCESS_TOKEN=xxxxxxxx
CHANNEL_SECRET=xxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxx
```
2) `npm i` → `npm start`
3) Railwayにデプロイ → Variables に同じ3つを登録
4) Webhook URL: `https://<railway-app>.up.railway.app/webhook`