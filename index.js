import express from "express";

const app = express();
app.use(express.json());

app.post("/webhook", (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      console.log("User says:", event.message.text);
    }
  }

  // ★超重要：即 200 を返す
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.send("Server is running 🐻");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Step2 bot running 🐻✨");
});
