import express from "express";

const app = express();

// JSON を受け取れるようにする（特に何もしない）
app.use(express.json());

// ------------- Webhook本体 -------------
// ★ポイント：とにかく 200 OK を返すだけ★
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));
  res.status(200).send("OK");
});

// ------------- 動作確認用 -------------
app.get("/", (req, res) => {
  res.send("Server is running");
});

// Railway 用ポート番号
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Minimal webhook server running on port ${PORT} 🐻`);
});
