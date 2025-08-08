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

// Healthcheck & webhook check
app.get('/', (_, res) => res.status(200).send('StudyEye LINE bot is running.'))
app.get('/webhook', (_, res) => res.status(200).send('OK'))

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
      const imgB64 = await fetchImageAsBase64(event.message.id)

      const system = [
        'あなたは「くまお先生」。やさしく面白く、絵文字たっぷりで教える先生。',
        '!!! 重要：LaTeX/TeX（\\frac, \\text, \\cdot 等）は使用禁止。数式は通常文字で表現：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '出力は **必ずこの順番・見出し**：',
        '1) ✨問題の要約',
        '2) 🔧解き方（箇条書きステップ）',
        '3) ✅【答え】（1行で明記）',
        '見出し名はそのまま使う。'
      ].join('\n')

      const user = [
        '画像の問題を読み取って、上の順番・見出しで日本語で返答してください。',
        '分数は a/b、平方根は √()、掛け算は · または × を使う。'
      ].join('\n')

      const comp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        messages: [
          { role: 'system', content: system },
          { role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imgB64}` } }
            ]
          }
        ]
      })

      let out = comp.choices?.[0]?.message?.content?.trim()
        || 'うまく読み取れなかったみたい…もう一度はっきり撮って送ってみてね📸'

      out = finalizeOutput(out)
      return client.replyMessage(event.replyToken, { type: 'text', text: out })
    }

    // テキストメッセージ
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text:
`✨ 写真で問題を送ってね！くまお先生がやさしく解説するよ🧸
✍️ 文字だけの質問もOK！
🔎 返答は ①問題の要約 → ②解き方 → ③【答え】 の順でお届けするよ🌟`
        })
      }

      const system = [
        'あなたは「くまお先生」。やさしく面白く、絵文字たっぷりで自然な会話をする。',
        'LaTeX/TeXは禁止。数式は通常文字で（√, ², ³, ×, ·, ≤, ≥, 1/2 など）。',
        '出力は **必ず** 次の順番・見出し：',
        '1) ✨問題の要約',
        '2) 🔧解き方（箇条書き）',
        '3) ✅【答え】（1行）'
      ].join('\n')

      const comp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ]
      })

      let out = comp.choices?.[0]?.message?.content?.trim()
        || 'ちょっと情報が足りないかも…もう少し詳しく教えてくれる？🧸'

      out = finalizeOutput(out)
      return client.replyMessage(event.replyToken, { type: 'text', text: out })
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
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

/* ===== 表示きれい化：LaTeX除去 + Unicode強化 + 見出し統一 ===== */
function finalizeOutput(raw) {
  let t = postProcess(raw)
  t = normalizeHeadings(t)
  t = enforceOrder(t)
  return t.trim()
}

// LaTeX除去＋Unicode強化
function postProcess(text) {
  let t = (text || '').replace(/¥/g, '\\')

  // LaTeX囲み削除
  t = t.replace(/\\\(|\\\)|\\\[|\\\]/g, '')
  t = t.replace(/\${1,2}/g, '')

  // \text{...} → 中身
  t = t.replace(/\\text\{([^{}]+)\}/g, '$1')

  // 記号
  t = t.replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\pm/g, '±')
  t = t.replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥')
  t = t.replace(/\\sqrt\s*\(\s*/g, '√(').replace(/sqrt\s*\(\s*/gi, '√(')

  // \frac{a}{b} → (a/b)
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')

  // 冪・添字
  t = t.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³')
  t = t.replace(/_1\b/g, '₁').replace(/_2\b/g, '₂').replace(/_3\b/g, '₃').replace(/_4\b/g, '₄').replace(/_5\b/g, '₅')

  // 合字分数
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/3\b/g, '⅓').replace(/\b2\/3\b/g, '⅔')
  t = t.replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾')

  // 数字*数字 → · / 数字 x 数字 → ×
  t = t.replace(/(?<=\d)\s*\*\s*(?=\d)/g, '·')
  t = t.replace(/(?<=\d)\s*x\s*(?=\d)/gi, '×')

  // 余分なバックスラッシュ/空行
  t = t.replace(/\\+/g, '').replace(/\n{3,}/g, '\n\n')

  return t
}

// 見出し表記を統一（多少ズレても正規化）
function normalizeHeadings(t) {
  // 問題の要約
  t = t.replace(/^\s*(#+\s*)?問題の要約\s*$/m, '✨問題の要約')
  t = t.replace(/^\s*(#+\s*)?(要点|要約)\s*$/m, '✨問題の要約')
  // 解き方
  t = t.replace(/^\s*(#+\s*)?解き方\s*$/m, '🔧解き方')
  t = t.replace(/^\s*(#+\s*)?(手順|ステップ)\s*$/m, '🔧解き方')
  // 答え
  // 既に【答え】がある場合はそのまま。なければ作らない（モデル指示で返す想定）
  return t
}

// セクション順序を保証：要約→解き方→【答え】
function enforceOrder(t) {
  // セクションを抽出
  const summary = extractSection(t, /✨問題の要約/i)
  const steps   = extractSection(t, /🔧解き方/i)
  const answer  = extractAnswer(t)

  const parts = []
  parts.push(summary || '✨問題の要約\n（要約を作成できなかったよ…もう一度撮ってみてね📸）')
  parts.push(steps   || '🔧解き方\n1) 重要な量を整理\n2) 式を立てて計算\n3) 単位も忘れずに確認')
  parts.push(answer  || '✅【答え】（取得できず）')

  return parts.join('\n\n').trim()
}

function extractSection(t, headerRegex) {
  const lines = t.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headerRegex.test(lines[i])) { start = i; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let j = start + 1; j < lines.length; j++) {
    if (/^✨問題の要約|^🔧解き方|^✅【答え】/.test(lines[j])) { end = j; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

function extractAnswer(t) {
  // 「【答え】」行を優先取得。無ければ推定。
  const m = t.match(/^[\s\S]*?(✅?【答え】[^\n]*)/m)
  if (m) {
    // 以降の行で別見出しが来るまで含める
    const rest = t.slice(t.indexOf(m[1]))
    const endIdx = rest.search(/\n(✨問題の要約|🔧解き方)\b/)
    const block = endIdx === -1 ? rest : rest.slice(0, endIdx)
    // 先頭に見出しを統一
    return block.replace(/^.*【答え】/m, '✅【答え】')
  }
  return null
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
