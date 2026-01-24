import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "CycloneOI AROME API",
    status: "running"
  });
});

app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
