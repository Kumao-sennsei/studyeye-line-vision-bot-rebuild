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

// In-memory sessions: { summary, steps, answer, suggestion, state }
const sessions = new Map()

// ランダム問いかけ
const PROMPT_AFTER_SUMMARY = [
  'ここまで大丈夫かな？👌',
  'この整理でイメージつかめた？✨',
  'どこまでOKそう？一緒に確認しよ🧸'
]
const PROMPT_AFTER_STEPS = [
  'ここからは一人で解けそう？🧸',
  'この先は自分でいけそうかな？💪',
  '続きはどう攻める？やってみる？🔥'
]
const pick = arr => arr[Math.floor(Math.random() * arr.length)]

app.get('/', (_, res) => res.status(200).send('Kumao LINE bot is running.'))
app.get('/webhook', (_, res) => res.status(200).send('OK'))

app.post('/webhook', middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(e => { console.error('Webhook error:', e); res.status(500).end() })
})

async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null
    const userId = event.source?.userId || 'unknown'

    /* ===== TEXT: その場でやさしく詳しく（正確重視・超自然会話） ===== */
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      // reset / help
      if (/^リセット$|^reset$/i.test(text)) {
        sessions.delete(userId)
        return reply(event.replyToken, 'セッションをリセットしたよ🧸また画像を送ってね📸')
      }
      if (/help|使い方|ヘルプ/i.test(text)) {
        return reply(event.replyToken,
`📸 画像は「少しずつ進める」対話。
✍️ テキストは「やさしく詳しく」すぐ解説するよ✨
途中で「リセット」でやり直せるよ🧸`)
      }

      // 画像の途中ステージなら優先処理
      const sess = sessions.get(userId)
      if (sess && (sess.state === 'await_ack_summary' || sess.state === 'await_ack_steps')) {
        if (sess.state === 'await_ack_summary') {
          sessions.set(userId, { ...sess, state: 'await_ack_steps' })
          const steps = formatSteps(sess.steps)    // ← これが無くて落ちてた
          return reply(event.replyToken, `🔧解き方\n${steps}\n\n${pick(PROMPT_AFTER_STEPS)}（むずい時は「ヒント」/ 解けたら答えを書いて送ってね）`)
        }
        if (sess.state === 'await_ack_steps') {
          // ショートカット：答え表示
          if (/答え|こたえ|ans(wer)?/i.test(text)) {
            sessions.set(userId, { ...sess, state: 'done' })
            const ans = ensureAnswerLine(sess.answer) // ← これも未定義だった
            const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
            sessions.delete(userId)
            return reply(event.replyToken, `✅${ans}\n\n${tail}`)
          }
          // ヒント or ネガティブ
          if (isNegative(text) || /ヒント|hint/i.test(text)) {
            const hint = await makeHint(sess).catch(err => {
              console.error('MakeHint error:', err)
              return 'まずは与えられた量と求めたい量を1行で整理しよう🧸\n必要なら「ヒント」ってもう一度言ってね✨'
            })
            return reply(event.replyToken, hint)
          }
          // 生徒の自分答え → 判定
          if (looksLikeAnswer(text)) {
            const judge = judgeAnswer(text, sess.answer)
            if (judge === 'correct') {
              sessions.set(userId, { ...sess, state: 'done' })
              const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
              sessions.delete(userId)
              return reply(event.replyToken, `${makePraise(text)}\n\n${tail}`)
            } else if (judge === 'incorrect') {
              const correction = await makeCorrection(sess, text).catch(err => {
                console.error('MakeCorrection error:', err)
                return '途中で符号か単位がズレたかも。もう一度、代入のところをゆっくり見直してみよう🧸'
              })
              return reply(event.replyToken, correction)
            }
            return reply(event.replyToken, '答えの書き方をもう少し具体的にしてみてね🧸（例：x=3、A、12N など）\nむずければ「ヒント」と送ってね✨')
          }
          // 前進合図
          if (isPositive(text)) {
            sessions.set(userId, { ...sess, state: 'done' })
            const ans = ensureAnswerLine(sess.answer)
            const tail = sess.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨'
            sessions.delete(userId)
            return reply(event.replyToken, `✅${ans}\n\n${tail}`)
          }
          // 中立
          return reply(event.replyToken, '大丈夫、ゆっくりでOKだよ🧸\n進めそうなら答えを送ってね。むずければ「ヒント」って言ってね✨')
        }
      }

      // 通常テキストQ&A（正確重視）
      const system = [
        'あなたは「くまお先生」。超自然な会話で、やさしく面白く、絵文字多めで教える。',
        '【重要】答えはできる限り正確に。計算・単位・論理の整合性を厳密に確認する。',
        'LaTeX/TeXは禁止（\\\\frac, \\\\text, \\\\cdot など）。数式は通常文字：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '出力構成：',
        '✨問題の要約',
        '🔧解き方（箇条書き3〜6ステップ：短く正確に）',
        '✅【答え】（1行で明記・単位も）',
        '最後に一言、やさしい励まし or 次の提案（1行）。'
      ].join('\n')

      let comp
      try {
        comp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text }
          ]
        })
      } catch (err) {
        console.error('OpenAI TEXT error:', err?.status, err?.message, err?.response?.data)
        return reply(event.replyToken, 'ごめんね💦（TEXT）内部でエラーが出たみたい。キーやモデルの設定を確認中だよ🙏')
      }

      let out = comp.choices?.[0]?.message?.content?.trim()
        || 'ちょっと情報が足りないかも…もう少し詳しく教えてくれる？🧸'

      out = finalizeText(out)
      return reply(event.replyToken, out)
    }

    /* ===== IMAGE: 段階対話（正確重視） ===== */
    if (event.message.type === 'image') {
      const imageB64 = await fetchImageAsBase64(event.message.id)

      const system = [
        'あなたは「くまお先生」。超自然な会話でやさしく面白く、絵文字も交える。',
        '【重要】答えはできる限り正確に。計算・単位・論理の整合性を厳密に確認する。',
        'LaTeX/TeXは使わない。数式は通常文字：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '次のJSONで厳密に出力（前後文禁止）：',
        '{ "summary": "...", "steps": ["...", "..."], "answer": "...", "suggestion": "..." }',
        '※ answer は1行・単位を含めて明記。'
      ].join('\n')

      const user = '画像の問題を読み取り、JSONで返すこと。答えはできる限り正確に。'

      let comp
      try {
        comp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.15,
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
      } catch (err) {
        console.error('OpenAI IMAGE error:', err?.status, err?.message, err?.response?.data)
        return reply(event.replyToken, 'ごめんね💦（IMAGE）内部エラー。少し待ってもう一度試してみてね🙏')
      }

      const raw = comp.choices?.[0]?.message?.content?.trim() || '{}'
      const parsed = safeParseJSON(raw)

      const summary = postProcess(parsed.summary || '（要約に失敗…もう一度撮ってみてね📸）')
      const steps = (parsed.steps || []).map(s => postProcess(s))
      const answer = postProcess(parsed.answer || '【答え】（取得できず）')
      const suggestion = postProcess(parsed.suggestion || '次は「確認テスト」や「少し難しい問題」にも挑戦してみる？✨')

      sessions.set(userId, { summary, steps, answer, suggestion, state: 'await_ack_summary' })
      return reply(event.replyToken, `✨問題の要約\n${summary}\n\n${pick(PROMPT_AFTER_SUMMARY)}`)
    }

    return null
  } catch (e) {
    console.error('handleEvent error:', e)
    try { await reply(event.replyToken, 'ごめんね💦 内部でエラーがあったよ。もう一度お試しください🙏') } catch {}
    return null
  }
}

/* ===== Helpers ===== */
function reply(replyToken, text) {
  return client.replyMessage(replyToken, { type: 'text', text })
}

// ★ 追加入れ忘れてた2つ
function formatSteps(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return '1) 重要な量を整理\n2) 式を立てて計算\n3) 単位を確認'
  }
  return arr.map((s, i) => `${i + 1}) ${s}`).join('\n')
}
function ensureAnswerLine(ansRaw) {
  const a = (ansRaw || '').trim()
  return /【答え】/.test(a) ? a : `【答え】${a}`
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

// JSONの安全パース（崩れた場合も救済）
function safeParseJSON(s) {
  try {
    const cleaned = (s || '').replace(/```json|```/g, '').trim()
    const m = cleaned.match(/\{[\s\S]*\}$/) // 末尾の { ... } を抽出
    const target = m ? m[0] : cleaned
    return JSON.parse(target)
  } catch (e) {
    console.error('JSON parse error:', e?.message, 'raw=', s)
    return {}
  }
}

/* ===== One-shot formatting for TEXT ===== */
function finalizeText(raw) {
  let t = postProcess(raw)
  t = t.replace(/^\s*(#+\s*)?問題の要約\s*$/m, '✨問題の要約')
       .replace(/^\s*(#+\s*)?(要点|要約)\s*$/m, '✨問題の要約')
       .replace(/^\s*(#+\s*)?解き方\s*$/m, '🔧解き方')
       .replace(/^\s*(#+\s*)?(手順|ステップ)\s*$/m, '🔧解き方')
  const blocks = []
  blocks.push(extractSection(t, /✨問題の要約/i) || '✨問題の要約\n（要約を作れなかったよ…）')
  blocks.push(extractSection(t, /🔧解き方/i) || '🔧解き方\n1) 重要な量を整理\n2) 式を立てて計算\n3) 単位を確認')
  blocks.push(extractAnswer(t) || '✅【答え】（取得できず）')
  return blocks.join('\n\n').trim()
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

/* ===== Math prettifier (LaTeX strip + Unicode) ===== */
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

/* ===== 判定・ヒント・ほめ/訂正 ===== */
function looksLikeAnswer(text) {
  return /-?\d+(\.\d+)?\s*[A-Za-z%℃度NnmmskgVJΩ]|^[\s\S]*[=＝]\s*-?\d|^[\s\S]*\b[ABCDＡ-Ｄ]\b|^\s*[xy]=/i.test(text)
}

function judgeAnswer(userText, solutionLine) {
  const user = normalizeAnswer(userText)
  const sol  = normalizeAnswer(solutionLine)

  if (user.choice && sol.choice && user.choice === sol.choice) return 'correct'
  if (sol.text && user.text && (user.text === sol.text || user.text.includes(sol.text) || sol.text.includes(user.text))) return 'correct'

  if (user.num != null && sol.num != null) {
    const tol = Math.max(Math.abs(sol.num) * 0.01, 0.01)
    if (Math.abs(user.num - sol.num) <= tol) return 'correct'
    return 'incorrect'
  }
  return 'unknown'
}

function normalizeAnswer(s) {
  const str = (s || '').replace(/【答え】/g, '').replace(/[＝=]\s*$/,'').trim()
  const mChoice = str.match(/\b([A-DＡ-Ｄ])\b/i)
  const choice = mChoice ? mChoice[1].toUpperCase().replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D') : null
  const mNum = str.match(/-?\d+(?:\.\d+)?/)
  const num = mNum ? parseFloat(mNum[0]) : null
  const text = str.replace(/\s+/g, '').replace(/[（）]/g, '').replace(/×/g, 'x').toLowerCase()
  return { choice, num, text }
}

function makePraise(userText) {
  return `🌟すばらしい！その答えで合ってるよ✨\n「${userText}」ナイス！自力でいけたの最高👏`
}

async function makeCorrection(sess, userText) {
  try {
    const system = [
      'あなたは「くまお先生」。やさしく、短く、要点だけ直す先生。超自然な会話で。',
      '【重要】正確さ重視。式の流れ・単位・符号の確認。',
      'LaTeX/TeXは禁止。数式は通常文字（√, ², ×, ·, ≤, ≥ など）。',
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
  } catch (e) {
    console.error('OpenAI correction error:', e?.status, e?.message, e?.response?.data)
    return '計算の途中で符号か単位がズレたかも。もう一度、式の代入部分をゆっくり確認してみよう🧸\n\nできたらもう一度答えを送ってみてね✨'
  }
}

async function makeHint(sess) {
  const system = [
    'あなたは「くまお先生」。やさしく短いヒントだけを出す先生（超自然会話）。',
    'LaTeX/TeXは禁止。数式は通常文字で（√, ², ×, · など）。',
    '絶対に最終的な数値や結論は言わない（答えは伏せる）。',
    'ヒントは最大3個、各1行。最後に「できそうならOK、もっと欲しければ『ヒント』って言ってね✨」を付ける。'
  ].join('\n')
  const user = JSON.stringify({ summary: sess.summary, steps: sess.steps })
  const comp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `この問題の要約と手順を元に、答えを出さない短いヒントを日本語で作って。\n${user}` }
    ]
  })
  const raw = comp.choices?.[0]?.message?.content?.trim()
    || 'まずは与えられた量を整理して、何を求めるのか1行で書き出してみよう🧸'
  return postProcess(raw)
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
