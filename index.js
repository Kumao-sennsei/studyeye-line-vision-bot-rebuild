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
        'あなたは「くまお先生」。やさしく面白く、絵文字たっぷりで自然な会話をする先生。',
        'LaTeX/TeX（\\frac, \\text, \\cdot など）は使わない。数式は通常文字：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '出力テンプレ（順番・見出しを厳守）：',
        '✨問題の要約',
        '（1行先生質問）ここまで大丈夫かな？👌',
        '🔧解き方',
        '（1行先生質問）ここからは一人で解けそう？🧸',
        '✅【答え】（1行で明記・単位も）',
        '（1行提案）次は「確認テスト」や「少し難しい問題」に挑戦してみる？✨',
        '※解き方は正確に。短い番号付きステップで。'
      ].join('\n')

      const user = '画像の問題を読み取って、上のテンプレどおりに日本語で返答してください。'

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

      out = finalizeOutput(out, /*interactive=*/true)
      return client.replyMessage(event.replyToken, { type: 'text', text: out })
    }

    // テキストメッセージ
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text:
`✨ 画像でも文字でもOK！くまお先生がやさしく解説するよ🧸
返答は「問題の要約 → 先生からの質問 → 解き方 → 先生からの質問 → 【答え】 → 次の提案」だよ🌟`
        })
      }

      const system = [
        'あなたは「くまお先生」。やさしく面白く、絵文字たっぷりで自然な会話をする。',
        'LaTeX/TeXは禁止。数式は通常文字で（√, ², ³, ×, ·, ≤, ≥, 1/2 など）。',
        '出力テンプレ（順番・見出し厳守）：',
        '✨問題の要約',
        'ここまで大丈夫かな？👌',
        '🔧解き方',
        'ここからは一人で解けそう？🧸',
        '✅【答え】（1行・単位も）',
        '次は確認テストや少し難しい問題にも挑戦してみる？✨'
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

      out = finalizeOutput(out, /*interactive=*/true)
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

/* ===== 表示きれい化 & 会話化 ===== */
function finalizeOutput(raw, interactive=false) {
  let t = postProcess(raw)
  t = normalizeHeadings(t)
  t = enforceOrder(t)
  if (interactive) t = ensurePrompts(t)
  return t.trim()
}

// LaTeX除去＋Unicode強化
function postProcess(text) {
  let t = (text || '').replace(/¥/g, '\\')
  t = t.replace(/\\\(|\\\)|\\\[|\\\]/g, '')
  t = t.replace(/\${1,2}/g, '')
  t = t.replace(/\\text\{([^{}]+)\}/g, '$1')
  t = t.replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\pm/g, '±')
  t = t.replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥')
  t = t.replace(/\\sqrt\s*\(\s*/g, '√(').replace(/sqrt\s*\(\s*/gi, '√(')
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')
  t = t.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³')
  t = t.replace(/_1\b/g, '₁').replace(/_2\b/g, '₂').replace(/_3\b/g, '₃').replace(/_4\b/g, '₄').replace(/_5\b/g, '₅')
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/3\b/g, '⅓').replace(/\b2\/3\b/g, '⅔')
  t = t.replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾')
  t = t.replace(/(?<=\d)\s*\*\s*(?=\d)/g, '·')
  t = t.replace(/(?<=\d)\s*x\s*(?=\d)/gi, '×')
  t = t.replace(/\\+/g, '').replace(/\n{3,}/g, '\n\n')
  return t
}

// 見出し統一
function normalizeHeadings(t) {
  t = t.replace(/^\s*(#+\s*)?問題の要約\s*$/m, '✨問題の要約')
  t = t.replace(/^\s*(#+\s*)?(要点|要約)\s*$/m, '✨問題の要約')
  t = t.replace(/^\s*(#+\s*)?解き方\s*$/m, '🔧解き方')
  t = t.replace(/^\s*(#+\s*)?(手順|ステップ)\s*$/m, '🔧解き方')
  // 【答え】はモデル出力を尊重
  return t
}

// セクション順序を保証：要約→解き方→【答え】
function enforceOrder(t) {
  const summary = extractSection(t, /✨問題の要約/i) || '✨問題の要約\n（要約を作成できなかったよ…もう一度撮ってみてね📸）'
  const steps   = extractSection(t, /🔧解き方/i)   || '🔧解き方\n1) 重要な量を整理\n2) 式を立てて計算\n3) 単位を確認'
  const answer  = extractAnswer(t)                  || '✅【答え】（取得できず）'
  return [summary, steps, answer].join('\n\n')
}

function extractSection(t, headerRegex) {
  const lines = t.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) if (headerRegex.test(lines[i])) { start = i; break }
  if (start === -1) return null
  let end = lines.length
  for (let j = start + 1; j < lines.length; j++) {
    if (/^✨問題の要約|^🔧解き方|^✅【答え】/.test(lines[j])) { end = j; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

function extractAnswer(t) {
  const m = t.match(/^[\s\S]*?(✅?【答え】[^\n]*)/m)
  if (m) {
    const rest = t.slice(t.indexOf(m[1]))
    const endIdx = rest.search(/\n(✨問題の要約|🔧解き方)\b/)
    const block = endIdx === -1 ? rest : rest.slice(0, endIdx)
    return block.replace(/^.*【答え】/m, '✅【答え】')
  }
  return null
}

// セクションの間に先生の問いかけ＆最後に提案を保証
function ensurePrompts(t) {
  const lines = t.split('\n')
  const out = []
  let sawSummary = false, sawSteps = false, sawAnswer = false
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    out.push(L)
    if (/^✨問題の要約/.test(L)) sawSummary = true
    else if (sawSummary && /^🔧解き方/.test(L) && !out.some(x => /ここまで大丈夫かな？/i.test(x))) {
      // 要約の直後に無ければ差し込み
      out.splice(out.length - 1, 0, 'ここまで大丈夫かな？👌')
    }
    if (/^🔧解き方/.test(L)) sawSteps = true
    else if (sawSteps && /^✅【答え】/.test(L) && !out.some(x => /一人で解けそう/i.test(x))) {
      out.splice(out.length - 1, 0, 'ここからは一人で解けそう？🧸')
    }
    if (/^✅【答え】/.test(L)) sawAnswer = true
  }
  // 末尾に提案がなければ足す
  if (sawAnswer && !out.some(x => /確認テスト|難しい問題|もう一問/i.test(x))) {
    out.push('次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨')
  }
  return out.join('\n')
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
