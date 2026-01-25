import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

/* =========================
   Utils
========================= */

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}

function extractCoverageIds(xml) {
  const ids = [];
  const re = /<wcs:CoverageId>([^<]+)<\/wcs:CoverageId>/g;
  let m;
  while ((m = re.exec(xml))) ids.push(m[1]);
  return ids;
}

// récupère le run le plus récent à partir des CoverageId
function latestRunStamp(ids) {
  let bestTs = null;
  let bestStr = null;

  for (const id of ids) {
    const m = id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/);
    if (!m) continue;

    const iso = m[1].replace(/\./g, ":");
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;

    if (!bestTs || ts > bestTs) {
      bestTs = ts;
      bestStr = m[1];
    }
  }
  return bestStr;
}

// sélection intelligente des variables (basée sur ce que MF fournit vraiment)
function pickCoverage(ids, stamp) {
  const find = (rx) => ids.find((id) => rx.test(id)) || null;

  return {
    rain_1h: find(/TOTAL_(WATER_)?PRECIPITATION.*PT1H/),
    rain_3h: find(/TOTAL_(WATER_)?PRECIPITATION.*PT3H/),
    gust: find(/WIND.*GUST/),
    temp_2m: find(/TEMPERATURE.*2M/),
    pressure_msl: find(/PRESSURE.*SEA/),
  };
}

/* =========================
   Routes
========================= */

// Healthcheck
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "CycloneOI AROME API",
    status: "running",
  });
});

// 1) Capabilities XML brut
app.get("/v1/arome/capabilities", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const url = capabilitiesUrl(run);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.AROME_APIKEY || "",
        accept: "application/xml",
      },
    });

    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 2) DEBUG – liste des CoverageId
app.get("/v1/arome/ids", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const filter = String(req.query.filter || "").toUpperCase();

    const r = await fetch(capabilitiesUrl(run), {
      headers: { apikey: process.env.AROME_APIKEY || "" },
    });

    const xml = await r.text();
    const ids = extractCoverageIds(xml);

    const filtered = filter
      ? ids.filter((id) => id.toUpperCase().includes(filter))
      : ids;

    res.json({
      ok: true,
      run,
      filter: filter || null,
      count: filtered.length,
      sample: filtered.slice(0, 100),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 3) Latest run + variables utiles
app.get("/v1/arome/latest", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);

    const r = await fetch(capabilitiesUrl(run), {
      headers: { apikey: process.env.AROME_APIKEY || "" },
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, mf_status: r.status });
    }

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    if (!stamp) {
      return res.status(500).json({ ok: false, error: "no_run_found" });
    }

    const coverage = pickCoverage(ids, stamp);

    res.json({
      ok: true,
      mf: "PE-AROME INDIEN 0.025",
      run,
      latest_run_stamp: stamp,
      coverage,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ========================= */

app.listen(PORT, () =>
  console.log("CycloneOI AROME API listening on", PORT)
);
