import 'dotenv/config'
import express from 'express'
import { middleware, Client } from '@line/bot-sdk'
import OpenAI from 'openai'

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

app.get('/', (req, res) => {
  res.status(200).send('StudyEye LINE bot is running.')
})

app.post('/webhook', middleware(config), async (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook error:', err)
      res.status(500).end()
    })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return Promise.resolve(null)

    if (event.message.type === 'image') {
      const messageId = event.message.id
      const imageB64 = await fetchImageAsBase64(messageId)

      const system = 'あなたは優秀な先生です。画像は生徒の質問（数学・理科・英語など）です。' +
                     '手順を分かりやすく、箇条書きで日本語で説明してください。式はテキストで、' +
                     '無理に難しい記号は使わず、中高生が理解できる表現にしてください。'

      const userInstruction = 'この画像の問題を読み取り、必要なら簡潔に要約し、' +
                              'その後に解き方のステップを番号付きで説明して。最後に「要点まとめ」を3つ。'

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user',
            content: [
              { type: 'text', text: userInstruction },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
            ]
          }
        ]
      })

      const answer = completion.choices?.[0]?.message?.content?.trim() || 'うまく解析できませんでした。もう一度撮影して送ってください。'

      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()
      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '写真で問題を送ってください。私が解き方を解説します。文字だけの質問もOKです。'
        })
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'あなたは優秀な先生です。中高生にも分かるように丁寧に日本語で解説してください。' },
          { role: 'user', content: text }
        ]
      })
      const answer = completion.choices?.[0]?.message?.content?.trim() || '回答を生成できませんでした。'
      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    return Promise.resolve(null)
  } catch (e) {
    console.error('handleEvent error:', e)
    try {
      await client.replyMessage(event.replyToken, { type: 'text', text: 'すみません、処理中にエラーが起きました。もう一度お試しください。' })
    } catch (_) {}
    return null
  }
}

async function fetchImageAsBase64(messageId) {
  const res = await client.getMessageContent(messageId)
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const buffer = Buffer.concat(chunks)
      resolve(buffer.toString('base64'))
    })
    res.on('error', reject)
  })
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
