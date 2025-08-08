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

const config = { channelAccessToken: CHANNEL_ACCESS_TOKEN, channelSecret: CHANNEL_SECRET }
const app = express()
const client = new Client(config)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

// Healthcheck
app.get('/', (req, res) => res.status(200).send('StudyEye LINE bot is running.'))
// Webhook確認用
app.get('/webhook', (req, res) => res.status(200).send('OK'))

// Webhook本体
app.post('/webhook', middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => { console.error('Webhook error:', err); res.status(500).end() })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null

    // 画像メッセージ
    if (event.message.type === 'image') {
      const messageId = event.message.id
      const imageB64 = await fetchImageAsBase64(messageId)

      const system = [
        'あなたは中高生向けの優しい先生「くまお先生」です。',
        '画像は生徒の問題です。読み取りが曖昧でも自然な解釈で解いてください。',
        '!!! 重要：**LaTeXやTeX記法（\\frac, \\text, \\cdot など）は一切使わない**。',
        '数式は通常の文字で表現（例：√, ², ³, ×, ·, ≤, ≥, 1/2 など）。',
        '解説は短く要点中心、手順は番号付き。最後に**必ず**「【答え】…」を1行で明記。'
      ].join('\n')

      const userInstruction = [
        '画像の問題を読み取り、要点→解き方ステップ→【答え】の順で出力してください。',
        '分数は a/b、平方根は √()、掛け算は · または × を使ってください。',
      ].join('\n')

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

      let answer = completion.choices?.[0]?.message?.content?.trim()
        || 'うまく解析できませんでした。もう一度撮影して送ってください。'

      answer = postProcess(answer)
      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    // テキストメッセージ
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      if (/help|使い方|ヘルプ/i.test(text)) {
        const help = [
          '📸 写真で問題を送ってね！くまお先生がやさしく解説するよ〜🧸',
          '✍️ 文字だけの質問もOK！',
          '✅ 最後は必ず【答え】を1行で明記して返すよ。'
        ].join('\n')
        return client.replyMessage(event.replyToken, { type: 'text', text: help })
      }

      const system = [
        'あなたは中高生向けの優しい先生「くまお先生」です。',
        '!!! LaTeX/TeX記法は禁止。通常の文字で数式を表現（√, ², ×, ≤ など）。',
        '最後は必ず「【答え】…」を1行で明記すること。'
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
    try { await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね💦 内部でエラーがあったよ。もう一度送ってみてね。' }) } catch {}
    return null
  }
}

async function fetchImageAsBase64(messageId) {
  const res = await client.getMessageContent(messageId)
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

// —— 数式のUnicode強化 & LaTeXの簡易変換（依存なし！）——
function postProcess(text) {
  // 日本語環境で「¥」が逆スラッシュ代わりに混ざるので先に統一
  let t = text.replace(/¥/g, '\\')

  // 1) TeXの環境/囲みを除去 \( \) \[ \] $$ $$
  t = t.replace(/\\\(|\\\)|\\\[|\\\]/g, '')
  t = t.replace(/\${1,2}/g, '')

  // 2) \text{...} → 中身だけ
  t = t.replace(/\\text\{([^{}]+)\}/g, '$1')

  // 3) 基本記号変換
  t = t.replace(/\\cdot/g, '·')
  t = t.replace(/\\times/g, '×')
  t = t.replace(/\\pm/g, '±')
  t = t.replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥')
  t = t.replace(/\\sqrt\s*\(\s*/g, '√(').replace(/sqrt\s*\(\s*/gi, '√(')

  // 4) 分数 \frac{a}{b} → (a/b)
  //   ネストは深追いせず、1段の素直な形だけ対応
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')

  // 5) 添字/冪（よく出るものだけ）
  t = t.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³')
  t = t.replace(/_1\b/g, '₁').replace(/_2\b/g, '₂').replace(/_3\b/g, '₃').replace(/_4\b/g, '₄').replace(/_5\b/g, '₅')

  // 6) 1/2 など代表分数の合字（読みやすさUP）
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/3\b/g, '⅓').replace(/\b2\/3\b/g, '⅔')
  t = t.replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾')

  // 7) 数字*数字 → 数字·数字（コード風 * を避ける）
  t = t.replace(/(?<=\d)\s*\*\s*(?=\d)/g, '·')
  // 数字 x 数字 → ×
  t = t.replace(/(?<=\d)\s*x\s*(?=\d)/gi, '×')

  // 8) 余分なバックスラッシュを軽く除去（変換後の残り）
  t = t.replace(/\\+/g, '')

  // 9) 連続空行の圧縮
  t = t.replace(/\n{3,}/g, '\n\n')

  // 10) 念のため【答え】が無ければ注意
  if (!/【答え】/.test(t)) {
    t += '\n\n※【答え】が見つからなかったよ。もう一度送ってみてね。'
  }
  return t
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
