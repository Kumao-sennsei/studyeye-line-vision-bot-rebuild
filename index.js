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
      const imageB64 = await fetchImageAsBase64(event.message.id)

      const system = [
        'あなたは「くまお先生」。やさしく、面白く、絵文字も交えて、自然な会話で教える先生です。',
        'LaTeX/TeX（\\frac, \\text, \\cdot など）は一切使わない。数式は通常の文字で：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '出力構成：',
        '①ひとこと励まし（1行）',
        '②「解き方」見出し → 箇条書きでステップ',
        '③最後に**必ず**「【答え】…」を1行で明記',
        '④最後に短い提案（例：「次は…してみよっか？」）',
      ].join('\n')

      const userInstruction = '画像の内容を読み取り、上の構成どおりに日本語で返答してください。'

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.25,
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
        || 'うまく読み取れなかったみたい…もう一度はっきり撮って送ってみてね📸'

      answer = teacherTone(postProcess(answer))
      return client.replyMessage(event.replyToken, { type: 'text', text: answer })
    }

    // テキストメッセージ
    if (event.message.type === 'text') {
      const text = (event.message.text || '').trim()

      if (/help|使い方|ヘルプ/i.test(text)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '📸 画像で問題を送ってね！くまお先生がやさしく解説するよ🧸\n✍️ 文字だけの質問もOK！\n✅ 最後に【答え】を1行で明記して返すよ。'
        })
      }

      const system = [
        'あなたは「くまお先生」。やさしく、面白く、絵文字も交えて自然な会話をする。',
        'LaTeX/TeXは禁止。数式は通常の文字で：√, ², ³, ×, ·, ≤, ≥, 1/2 など。',
        '出力構成：励まし1行→「解き方」見出し→手順→【答え】→最後に短い提案。',
      ].join('\n')

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.25,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ]
      })

      let answer = completion.choices?.[0]?.message?.content?.trim()
        || 'ちょっと情報が足りないかも…もう少し詳しく教えてくれる？🧸'

      answer = teacherTone(postProcess(answer))
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
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
    res.on('error', reject)
  })
}

/*** --- ここから表示きれい化 --- ***/
// LaTeX除去＋Unicode強化
function postProcess(text) {
  let t = (text || '').replace(/¥/g, '\\') // 全角バックスラッシュ対策

  // LaTeX囲み削除
  t = t.replace(/\\\(|\\\)|\\\[|\\\]/g, '')
  t = t.replace(/\${1,2}/g, '')

  // \text{...} → 中身
  t = t.replace(/\\text\{([^{}]+)\}/g, '$1')

  // 基本記号
  t = t.replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\pm/g, '±')
  t = t.replace(/\\leq/g, '≤').replace(/\\geq/g, '≥')
  t = t.replace(/<=/g, '≤').replace(/>=/g, '≥')
  t = t.replace(/\\sqrt\s*\(\s*/g, '√(').replace(/sqrt\s*\(\s*/gi, '√(')

  // \frac{a}{b} → (a/b)（1段のみ）
  t = t.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1/$2)')

  // 冪・添字
  t = t.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³')
  t = t.replace(/_1\b/g, '₁').replace(/_2\b/g, '₂').replace(/_3\b/g, '₃').replace(/_4\b/g, '₄').replace(/_5\b/g, '₅')

  // 合字分数（代表）
  t = t.replace(/\b1\/2\b/g, '½').replace(/\b1\/3\b/g, '⅓').replace(/\b2\/3\b/g, '⅔')
  t = t.replace(/\b1\/4\b/g, '¼').replace(/\b3\/4\b/g, '¾')

  // 数字*数字 → 数字·数字、数字 x 数字 → ×
  t = t.replace(/(?<=\d)\s*\*\s*(?=\d)/g, '·')
  t = t.replace(/(?<=\d)\s*x\s*(?=\d)/gi, '×')

  // 余分なバックスラッシュ除去 & 連続空行圧縮
  t = t.replace(/\\+/g, '').replace(/\n{3,}/g, '\n\n')

  // 答え確認
  if (!/【答え】/.test(t)) {
    t += '\n\n※【答え】が見つからなかったよ。もう一度送ってみてね。'
  }
  return t
}

// くまお先生トーン整形＋提案を添える
function teacherTone(text) {
  // 末尾に提案が無ければ、短い提案を足す
  const hasSuggestion = /次は|つぎは|もう一問|練習問題|復習/.test(text)
  const suggestion = pickSuggestion(text)
  let t = text

  // 先頭の見出しをちょい可愛く
  t = t.replace(/^#+\s*解き方/m, '🧸 **解き方**')

  if (!hasSuggestion) t += `\n\n${suggestion}`
  return t
}

function pickSuggestion(text) {
  // ざっくり科目推定で一言提案
  if (/速度|加速度|力|N|m\/s/.test(text)) {
    return '💡 次は「力のつり合い」の基本問題も1問だけやってみよっか？'
  }
  if (/方程式|連立|一次|二次/.test(text)) {
    return '✏️ 次は係数をちょっと変えた「練習問題」を1問だけ解いてみよっか？'
  }
  if (/三角|sin|cos|tan|角度/.test(text)) {
    return '📐 次は sin・cos の値の暗記チェック、小テストしてみる？'
  }
  if (/比例|反比例/.test(text)) {
    return '📊 次はグラフを書いて、傾きと切片を確認してみよっか？'
  }
  return '✅ 次は同じタイプの問題をもう1問だけ解いてみよっか？できたら実力ぐんとUPだよ！'
}

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`)
})
