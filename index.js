const line = require('@line/bot-sdk');
const express = require('express');
const axios = require('axios');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

app.post('/webhook', line.middleware(config), async (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  
  if (event.message.type === 'text') {
    return handleText(event);
  } else if (event.message.type === 'image') {
    return handleImage(event);
  }
}

async function handleText(event) {
  const question = event.message.text;
  const answer = await getKumaoAnswer(question);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: answer
  });
}

async function handleImage(event) {
  const messageContent = await client.getMessageContent(event.message.id);
  let chunks = [];
  messageContent.on('data', chunk => chunks.push(chunk));
  messageContent.on('end', async () => {
    const imgBuffer = Buffer.concat(chunks);
    const base64Img = imgBuffer.toString('base64');
    
    const answer = await getKumaoAnswer(`画像から読み取った問題を解説して: ${base64Img}`);
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: answer
    });
  });
}

async function getKumaoAnswer(question) {
  try {
    const prompt = `
あなたは「神仙人くまお先生」です。やさしく・面白く・わかりやすく解説します。
重要部分は 🔶、公式は 🔷、答えは 🟧 で示してください。
数式は LaTeX を使わず、わかりやすいテキスト表記にしてください。
途中式は省略せず、文章で補足しながら書いてください。
  
質問: ${question}
`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error(err);
    return 'ごめんね、解説でちょっとつまづいたみたい…もう一度試してみて！(●´ω｀●)';
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Kumao-sensei bot is running!');
});
