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

// ユーザーごとの進行状態を保持（メモリ：再起動で消える想定）
const sessions = new Map()
// セッションの保存データ：{ summary, steps, answer, suggestion, state }

app.get('/', (_, res) => res.status(200).send('StudyEye LINE bot is running.'))
app.get('/webhook', (_, res) => res.status(200).send('OK'))

app.post('/webhook', middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(e => {
    console.error('Webhook error:', e)
    res.status(500).end()
  })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null
    const userId = event.source?.userId || 'unknown'

    // テキストメッセージでステート遷移
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      // リセットコマンド
      if (/^リセット$|^reset$/i.test(text)) {
        sessions.delete(userId)
        return client.replyMessage(event.replyToken, { type: 'text', text: 'セッションをリセットしたよ🧸また画像を送ってね📸' })
      }

      // ヘルプ
      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '📸 まずは問題の写真を送ってね！\n要約→「ここまで大丈夫かな？」→解き方→「一人で解けそう？」→答え の順で少しずつ進めるよ✨\n途中で「リセット」と送るとやり直せるよ。' })
      }

      const sess = sessions.get(userId)
      if (!sess) {
        // セッションがないのに返信が来たとき
        return client.replyMessage(event.replyToken, { type: 'text', text: 'まずは問題の写真を送ってね📸\nそこから順番に一緒に進めよう🧸' })
      }

      // 状態に応じて次を出す
      if (sess.state === 'await_ack_summary') {
        // 生徒の返事を受けて → 解き方を提示し、次の問いかけ
        sess.state = 'await_ack_steps'
        const steps = formatSteps(sess.steps)
        const msg = `🔧解き方\n${steps}\n\nここからは一人で解けそう？🧸`
        return client.replyMessage(event.replyToken, { type: 'text', text: msg })
      }

      if (sess.state === 'await_ack_steps') {
        // 生徒の返事を受けて → 答え＆提案を提示して完了
        sess.state = 'done'
        const ans = ensureAnswerLine(sess.answer)
        const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
        sessions.delete(userId)
        return client.replyMessage(event.replyToken, { type: 'text', text: `✅${ans}\n\n${tail}` })
      }

      // 既にdone
      return client.replyMessage(event.replyToken, { type: 'text', text: 'また新しい問題を送ってね📸 一緒に進めよう🧸' })
    }

    // 画像メッセージ：ここで要約/解き方/答え/提案を作成して保存 → 要約だけ送る
    if (event.message.type === 'image') {
      const imageB64 = await fetchImageAsBase64(event.message.id)

      // JSONで構造化して出させる（LaTeX禁止＆通常文字で）
      const system = [
        'あなたは「くまお先生」。やさしく面白く、絵文字も交えて自然な会話をする先生。',
        'LaTeX/TeX（\\frac, \\text, \\cdot 等）は禁止。数式は通常文字：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '次のJSON形式で**厳密に**出力して（前後の説明文は一切不要）：',
        '{ "summary": "...", "steps": ["...", "..."], "answer": "...", "suggestion": "..." }',
        '※ answer は1行で明記し、必要なら単位も含める。'
      ].join('\n')

      const user = '画像の問題を読み取り、上記JSON形式で返してください。'

      const comp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user',
            content: [
              { type: 'text', text: user },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
            ]
          }
        ]
      })

      const raw = comp.choices?.[0]?.message?.content?.trim() || '{}'
      const parsed = safeParseJSON(raw)

      const summary = postProcess(parsed.summary || '（要約に失敗したよ…もう一度撮ってみてね📸）')
      const steps = (parsed.steps || []).map(s => postProcess(s))
      const answer = postProcess(parsed.answer || '【答え】（取得できず）')
      const suggestion = postProcess(parsed.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨')

      // セッション保存：要約→待つ から開始
      sessions.set(userId, { summary, steps, answer, suggestion, state: 'await_ack_summary' })

      // 要約だけ送って、問いかけで止める
      const msg = `✨問題の要約\n${summary}\n\nここまで大丈夫かな？👌`
      return client.replyMessage(event.replyToken, { type: 'text', text: msg })
    }

    return null
  } catch (e) {
    console.error('handleEvent error:', e)
    try { await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね💦 内部でエラーがあったよ。もう一度送ってみてね。' }) } catch {}
    return null
  }
}

/* ===== ユーティリティ ===== */
async function fetchImageAsBase64(messageId) {
  const res = await client.getMessageContent(messageId)
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

function safeParseJSON(s) {
  try {
    // モデルが ```json ... ``` を付ける場合をケア
    const cleaned = s.replace(/```json|```/g, '').trim()
    return JSON.parse(cleaned)
  } catch {
    return {}
  }
}

// 数式きれい化（LaTeX除去＋Unicode）
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
  return t.trim()
}

function formatSteps(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '1) 重要な量を整理\n2) 式を立てて計算\n3) 単位を確認'
  return arr.map((s, i) => `${i+1}) ${s}`).join('\n')
}

function ensureAnswerLine(ansRaw) {
  const a = ansRaw || ''
  if (/【答え】/.test(a)) return a
  return `【答え】${a}`
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
