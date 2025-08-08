import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { middleware, Client } from '@line/bot-sdk'
import OpenAI from 'openai'
import katex from 'katex'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- ENV ---
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  OPENAI_API_KEY,
  PORT = 3000,
  BASE_URL, // 例: https://web-production-xxxx.up.railway.app
} = process.env

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET || !OPENAI_API_KEY) {
  console.error('Missing env. Please set CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, OPENAI_API_KEY')
  process.exit(1)
}

// 保存先（RailwayのエフェメラルFSでOK。短期キャッシュ想定）
const OUT_DIR = path.join(__dirname, 'public', 'img')
fs.mkdirSync(OUT_DIR, { recursive: true })

const lineConfig = { channelAccessToken: CHANNEL_ACCESS_TOKEN, channelSecret: CHANNEL_SECRET }
const app = express()
const client = new Client(lineConfig)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// static 配信（生成画像を配信）
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }))

// Healthcheck
app.get('/', (_, res) => res.status(200).send('StudyEye LINE bot is running.'))

// Webhook確認用
app.get('/webhook', (_, res) => res.status(200).send('OK'))

// Webhook本体
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(e => {
    console.error('Webhook error:', e)
    res.status(500).end()
  })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null

    if (event.message.type === 'image') {
      const messageId = event.message.id
      const imageB64 = await fetchImageAsBase64(messageId)

      // 1回目: 解説を生成
      const system = 'あなたは優秀な先生です。画像は生徒の質問です。中高生が理解できる日本語で、手順を番号付きで簡潔に説明してください。'
      const userInstruction = 'この画像の問題を読み取り、要点→解き方ステップを説明して。最後に「要点まとめ」を3つ。'

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
              { type: 'text', text: userInstruction },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
            ]
          }
        ]
      })
      const answer = completion.choices?.[0]?.message?.content?.trim() || 'うまく解析できませんでした。もう一度撮影して送ってください。'

      // 2回目: 「見出しの1本の代表数式」をLaTeXで出してもらう（画像化用）
      const latexResp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.0,
        messages: [
          { role: 'system', content: '与えた解説テキストの中から、学習者が視覚的に理解を助ける1本の代表的な数式だけをLaTeXで返して。前後の説明や$記号は不要。返答は生のLaTeX一行のみ。' },
          { role: 'user', content: answer }
        ]
      })
      const latex = (latexResp.choices?.[0]?.message?.content || '').trim()

      // 画像化（LaTeXが取れたときのみ）
      let imageUrl = null
      if (latex && BASE_URL) {
        try {
          imageUrl = await renderLatexToPngAndGetUrl(latex)
        } catch (e) {
          console.error('Render error:', e)
        }
      }

      // 返信: 先にテキスト、数式があれば画像も
      const msgs = [{ type: 'text', text: answer }]
      if (imageUrl) {
        msgs.push({
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl
        })
      }
      return client.replyMessage(event.replyToken, msgs)
    }

    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      // help
      if (/^help$|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '写真で問題を送ってください。解説を返します。数式は画像でも表示します。'
        })
      }

      // テキストの質問
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'あなたは優秀な先生です。中高生にも分かる丁寧な日本語で解説してください。' },
          { role: 'user', content: text }
        ]
      })
      const answer = completion.choices?.[0]?.message?.content?.trim() || '回答を生成できませんでした。'

      // 代表数式を抽出→画像化トライ
      let imageUrl = null
      if (BASE_URL) {
        try {
          const latexResp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.0,
            messages: [
              { role: 'system', content: '与えた解説テキストの中から、学習者が視覚的に理解を助ける1本の代表的な数式だけをLaTeXで返して。前後の説明や$記号は不要。返答は生のLaTeX一行のみ。' },
              { role: 'user', content: answer }
            ]
          })
          const latex = (latexResp.choices?.[0]?.message?.content || '').trim()
          if (latex) imageUrl = await renderLatexToPngAndGetUrl(latex)
        } catch (e) {
          console.error('Render error:', e)
        }
      }

      const msgs = [{ type: 'text', text: answer }]
      if (imageUrl) {
        msgs.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl })
      }
      return client.replyMessage(event.replyToken, msgs)
    }

    return null
  } catch (e) {
    console.error('handleEvent error:', e)
    try { await client.replyMessage(event.replyToken, { type: 'text', text: 'すみません、処理中にエラーが起きました。もう一度お試しください。' }) } catch {}
    return null
  }
}

async function fetchImageAsBase64(messageId) {
  const res = await client.getMessageContent(messageId)
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

// LaTeX -> SVG -> PNG 変換してURLを返す
async function renderLatexToPngAndGetUrl(latex) {
  // KaTeXでSVG生成
  const svg = katex.renderToString(latex, { throwOnError: false, output: 'htmlAndMathml', displayMode: true })
  // KaTeXのHTMLから<math>部分だけだと装飾薄いので、そのままSVG化用ラッパー
  const svgWrapped = `
    <svg xmlns="http://www.w3.org/2000/svg">
      <foreignObject x="0" y="0" width="1000" height="400">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:28px; padding:16px; background:#ffffff;">
          ${svg}
        </div>
      </foreignObject>
    </svg>`

  const pngBuffer = await sharp(Buffer.from(svgWrapped))
    .png({ quality: 90 })
    .toBuffer()

  const hash = crypto.createHash('md5').update(latex).digest('hex')
  const file = path.join(OUT_DIR, `${hash}.png`)
  fs.writeFileSync(file, pngBuffer)

  if (!BASE_URL) throw new Error('BASE_URL is not set')
  return `${BASE_URL}/static/img/${path.basename(file)}`
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
