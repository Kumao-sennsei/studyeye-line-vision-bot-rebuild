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

// ユーザーごとの進行状態（メモリ）
const sessions = new Map()
// { summary, steps, answer, suggestion, state }

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

    // ===== テキストメッセージ =====
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      // リセット
      if (/^リセット$|^reset$/i.test(text)) {
        sessions.delete(userId)
        return client.replyMessage(event.replyToken, { type: 'text', text: 'セッションをリセットしたよ🧸また画像を送ってね📸' })
      }

      // ヘルプ
      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '📸 まずは問題の写真を送ってね！\n要約→「ここまで大丈夫かな？」→解き方→「一人で解けそう？」→答え の順で少しずつ進めるよ✨\n途中で「リセット」でやり直せるよ。' })
      }

      const sess = sessions.get(userId)
      if (!sess) {
        // 答えショートカット（セッションなしでも答え要求が来た）
        if (/答え|こたえ|ans(wer)?/i.test(text)) {
          return client.replyMessage(event.replyToken, { type: 'text', text: 'まずは問題の写真を送ってね📸\n一緒に順番に進めよう🧸' })
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: 'まずは問題の写真を送ってね📸\nそこから順番に一緒に進めよう🧸' })
      }

      // ===== 状態遷移 =====
      if (sess.state === 'await_ack_summary') {
        // 生徒の返事を受けて → 解き方を提示し、次の問いかけ
        sess.state = 'await_ack_steps'
        const steps = formatSteps(sess.steps)
        const msg = `🔧解き方\n${steps}\n\nここからは一人で解けそう？🧸（むずい時は「ヒント」/ 解けたら答えを書いて送ってね）`
        return client.replyMessage(event.replyToken, { type: 'text', text: msg })
      }

      if (sess.state === 'await_ack_steps') {
        // 1) 即「答え見せて」派
        if (/答え|こたえ|ans(wer)?/i.test(text)) {
          sessions.set(userId, { ...sess, state: 'done' })
          const ans = ensureAnswerLine(sess.answer)
          const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
          sessions.delete(userId)
          return client.replyMessage(event.replyToken, { type: 'text', text: `✅${ans}\n\n${tail}` })
        }

        // 2) ヒント希望 or ネガティブ反応
        if (isNegative(text) || /ヒント|hint/i.test(text)) {
          const hint = await makeHint(sess)
          return client.replyMessage(event.replyToken, { type: 'text', text: hint })
        }

        // 3) 生徒が自分の「解答」を送ってきた場合 → 判定
        if (looksLikeAnswer(text)) {
          const judge = judgeAnswer(text, sess.answer) // correct / incorrect / unknown
          if (judge === 'correct') {
            sessions.set(userId, { ...sess, state: 'done' })
            const praise = makePraise(text)
            const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
            sessions.delete(userId)
            return client.replyMessage(event.replyToken, { type: 'text', text: `${praise}\n\n${tail}` })
          } else if (judge === 'incorrect') {
            const correction = await makeCorrection(sess, text)
            return client.replyMessage(event.replyToken, { type: 'text', text: correction })
          }
          // unknown → 促し
          return client.replyMessage(event.replyToken, { type: 'text', text: '答えの書き方をもう少し具体的にしてみてね🧸（例：x=3、A、12N など）\nむずければ「ヒント」と送ってね✨' })
        }

        // 4) ポジティブ合図 → そのまま答えへ
        if (isPositive(text)) {
          sessions.set(userId, { ...sess, state: 'done' })
          const ans = ensureAnswerLine(sess.answer)
          const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
          sessions.delete(userId)
          return client.replyMessage(event.replyToken, { type: 'text', text: `✅${ans}\n\n${tail}` })
        }

        // 5) 中立 → 促し
        return client.replyMessage(event.replyToken, { type: 'text', text: '大丈夫、ゆっくりでOKだよ🧸\n進めそうなら答えを送ってね。むずければ「ヒント」って言ってね✨' })
      }

      // 既に完了
      return client.replyMessage(event.replyToken, { type: 'text', text: 'また新しい問題を送ってね📸 一緒に進めよう🧸' })
    }

    // ===== 画像メッセージ：要約/解き方/答え/提案を準備 → 要約だけ送って待つ =====
    if (event.message.type === 'image') {
      const imageB64 = await fetchImageAsBase64(event.message.id)

      // 構造化JSONで生成
      const system = [
        'あなたは「くまお先生」。やさしく面白く、絵文字も交えて自然な会話をする先生。',
        'LaTeX/TeX（\\frac, \\text, \\cdot 等）は禁止。数式は通常文字：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '次のJSON形式で厳密に出力（前後の説明禁止）：',
        '{ "summary": "...", "steps": ["...", "..."], "answer": "...", "suggestion": "..." }',
        '※ answer は1行で明記（単位があれば含める）。'
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

      sessions.set(userId, { summary, steps, answer, suggestion, state: 'await_ack_summary' })

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

/* ========== ユーティリティ ========== */
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
    const cleaned = s.replace(/```json|```/g, '').trim()
    return JSON.parse(cleaned)
  } catch { return {} }
}

// 置換で読みやすく（LaTeX除去＋Unicode）
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

// ====== 判定＆リアクション ======
function looksLikeAnswer(text) {
  // 数字・単位・記号・選択肢のいずれかが入っていれば「答えっぽい」
  return /-?\d+(\.\d+)?\s*[A-Za-z%℃度NnmmskgVJΩ]|^[\s\S]*[=＝]\s*-?\d|^[\s\S]*\b[ABCDＥＥ]\b|^\s*[xy]=/i.test(text)
}

function judgeAnswer(userText, solutionLine) {
  // 解の正規化
  const user = normalizeAnswer(userText)
  const sol  = normalizeAnswer(solutionLine)

  // A/B/C/D 形式の一致
  if (user.choice && sol.choice && user.choice === sol.choice) return 'correct'

  // 文字/式の包含一致（荒め）
  if (sol.text && user.text && (user.text === sol.text || user.text.includes(sol.text) || sol.text.includes(user.text))) {
    return 'correct'
  }

  // 数値の近似一致（±1% or ±0.01 の大きい方）
  if (user.num != null && sol.num != null) {
    const tol = Math.max(Math.abs(sol.num) * 0.01, 0.01)
    if (Math.abs(user.num - sol.num) <= tol) return 'correct'
    return 'incorrect'
  }

  // どっちかしか取れないときは不明
  return 'unknown'
}

function normalizeAnswer(s) {
  const str = (s || '').replace(/【答え】/g, '').replace(/[＝=]\s*$/,'').trim()

  // 選択肢抽出
  const mChoice = str.match(/\b([A-DＡ-Ｄ])\b/i)
  const choice = mChoice ? mChoice[1].toUpperCase().replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D') : null

  // 数値抽出（先頭の代表値）
  const mNum = str.match(/-?\d+(?:\.\d+)?/)
  const num = mNum ? parseFloat(mNum[0]) : null

  // 記号・スペース整形したテキスト
  const text = str
    .replace(/\s+/g, '')
    .replace(/[（）]/g, '')
    .replace(/×/g, 'x')
    .toLowerCase()

  return { choice, num, text }
}

function makePraise(userText) {
  return `🌟すばらしい！その答えで合ってるよ✨\n「${userText}」ナイス！自力でいけたの最高👏`
}

async function makeCorrection(sess, userText) {
  try {
    const system = [
      'あなたは「くまお先生」。やさしく、短く、要点だけ直す先生。',
      'LaTeX/TeXは禁止。数式は通常文字で（√, ², ×, ·, ≤, ≥ など）。',
      'ゴール：生徒の答えのズレを1〜3点で指摘 → 正しいアプローチを簡潔に → 最後に励まし。',
      '最終的な【答え】はまだ言わず、やり直しを促す。'
    ].join('\n')

    const user = JSON.stringify({
      summary: sess.summary,
      steps: sess.steps,
      expectedAnswer: sess.answer,
      studentAnswer: userText
    })

    const comp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `次の情報を参考に、やさしく短い訂正メッセージを日本語で作って。\n${user}` }
      ]
    })
    const raw = comp.choices?.[0]?.message?.content?.trim()
      || '計算の途中で符号か単位がズレたかも。もう一度、式の代入部分をゆっくり確認してみよう🧸'
    return postProcess(raw + '\n\nできたらもう一度答えを送ってみてね✨')
  } catch {
    return '計算の途中で符号か単位がズレたかも。もう一度、式の代入部分をゆっくり確認してみよう🧸\n\nできたらもう一度答えを送ってみてね✨'
  }
}

function isNegative(text) {
  return /(無理|できない|できなさそう|わからない|分からない|むずい|難しい|ムズい|ムズ)/i.test(text)
}
function isPositive(text) {
  return /(OK|オーケー|わかった|分かった|理解|大丈夫|いける|できそう|進めて|次へ|go|ゴー)/i.test(text)
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
