import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

// ----- Config -----
const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001"; // membre 001 (comme tes tests)

// ----- Health -----
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "CycloneOI AROME API",
    status: "running"
  });
});

// ----- AROME: GetCapabilities (XML brut) -----
app.get("/v1/arome/capabilities", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT).trim();

    const url =
      `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities` +
      `?service=WCS&version=2.0.1&language=fre`;

    const r = await fetch(url, {
      headers: {
        // ta clé est dans les variables d'environnement Fly
        apikey: process.env.AROME_APIKEY || "",
        accept: "application/xml,text/xml,*/*"
      }
    });

    const text = await r.text();

    res.status(r.status);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // CORS (pratique pour tester au navigateur)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "capabilities_failed",
      message: String(e?.message || e)
    });
  }
});

app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
