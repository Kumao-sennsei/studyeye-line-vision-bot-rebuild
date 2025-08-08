import 'dotenv/config'
import express from 'express'
import { middleware, Client } from '@line/bot-sdk'
import OpenAI from 'openai'

// ==== ENV ====
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  OPENAI_API_KEY,
  PORT = 3000
} = process.env

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error('Missing env. Please set CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY')
  process.exit(1)
}

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET
}

const app = express()
const client = new Client(config)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// ---- Health & webhook check ----
app.get('/', (req, res) => res.status(200).send('StudyEye LINE bot is running.'))
app.get('/webhook', (req, res) => res.status(200).send('OK'))

// ---- Webhook ----
app.post('/webhook', middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error('Webhook error:', err)
      res.status(500).end()
    })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null

    if (event.message.type === 'image') {
      const messageId = event.message.id
      const imageB64 = await fetchImageAsBase64(messageId)

      const system = [
        'あなたは中高生向けの超やさしい先生「くまお先生」です。',
        '画像は生徒の問題です。読み取りが曖昧な場合は最も自然な解釈で解いてください。',
        '出力の最後に **必ず** 「【答え】…」を1行で明記してください（数値/式/選択肢）。',
        '解説は短く、手順は番号付きで。数式はできるだけ簡潔。'
      ].join('\n')

      const userInstruction = [
        '画像の問題を読み取り、重要点→解き方→最後に【答え】を必ず1行で明記してください。',
        '途中式は簡潔に。分数は a/b 形式可。平方根は sqrt() を使ってOK。',
      ].join('\n')

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: userInstruction },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
            ]
          }
        ]
      })

      let answer = completion.choices?.[0]?.message?.content?.trim()
        || 'うまく解析できませんでした。もう一度撮影して送ってください。'

      answer = postProcess(answer) // ← Unicode強化＆体裁整え

      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      if (/help|使い方|ヘルプ/i.test(text)) {
        const help = [
          '📸 写真で問題を送ってね！くまお先生が解説するよ。',
          '✍️ 文字だけの質問もOK！',
          '✅ 最後に【答え】を必ず明記して返すよ。'
        ].join('\n')
        return client.replyMessage(event.replyToken, { type: 'text', text: help })
      }

      const system = [
        'あなたは中高生向けの超やさしい先生「くまお先生」です。',
        '最後に **必ず** 「【答え】…」を1行で明記してください。'
      ].join('\n')

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ]
      })

      let answer = completion.choices?.[0]?.message?.content?.trim()
        || '回答を生成できませんでした。'

      answer = postProcess(answer)

      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    return null
  } catch (e) {
    console.error('handleEvent error:', e)
    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね💦 内部でエラーがあったよ。もう一度送ってみてね。' })
    } catch {}
    return null
  }
}

// ---- helpers ----
async function fetchImageAsBase64(messageId) {
  const res = await client.getMessageContent(messageId)
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

// ② 数式のUnicode強化 & 体裁整え
function postProcess(text) {
  let t = text

  // パワー（^2, ^3 → ², ³）
  t = t.replace(/\^2\b/g, '²')
  t = t.replace(/\^3\b/g, '³')

  // 添字（_1,_2 → ₁,₂）※よくある1〜5のみ変換
  t = t.replace(/_1\b/g, '₁').replace(/_2\b/g, '₂').replace(/_3\b/g, '₃').replace(/_4\b/g, '₄').replace(/_5\b/g, '₅')

  // ルート表現 sqrt(x) → √(x)
  t = t.replace(/sqrt\s*\(\s*/gi, '√(')

  // 掛け算の可読化 * → ·（ただしコード風行はやりすぎない）
  t = t.replace(/(?<=\d)\s*\*\s*(?=\d)/g, '·')

  // × の簡易置換（ a x b では誤爆するので数字×数字だけ）
  t = t.replace(/(?<=\d)\s*x\s*(?=\d)/gi, '×')

  // 不等号の見やすさ
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥')

  // 分数は a/b のままが安定。1/2 等の代表は合字に置換
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/3\b/g, '⅓').replace(/\b2\/3\b/g, '⅔')
  t = t.replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾')

  // 余計な連続空行を詰める
  t = t.replace(/\n{3,}/g, '\n\n')

  // 【答え】が見出し末尾に来るように最終整形（念のため）
  if (!/【答え】/.test(t)) {
    // まれに抜けたら末尾に注意喚起
    t += '\n\n※【答え】が見つからなかったよ。もう一度送ってみてね。'
  }
  return t
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
