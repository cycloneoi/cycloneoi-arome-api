import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

// ===== CONFIG =====
const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// ===== HELPERS =====
function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}

function extractCoverageIds(xmlText) {
  const ids = [];
  const re = /<wcs:CoverageId>([^<]+)<\/wcs:CoverageId>/g;
  let m;
  while ((m = re.exec(xmlText))) ids.push(m[1]);
  return ids;
}

// Cherche le run le plus récent dans les CoverageId : ...__YYYY-MM-DDTHH.MM.SSZ...
function latestRunStamp(ids) {
  let best = null;
  let bestStr = null;

  for (const id of ids) {
    const mm = id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/);
    if (!mm) continue;

    const iso = mm[1].replace(/\./g, ":"); // 00.00.00Z -> 00:00:00Z
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;

    if (best === null || t > best) {
      best = t;
      bestStr = mm[1];
    }
  }
  return bestStr; // ex: 2026-01-25T00.00.00Z
}

function pickCoverage(ids, stamp) {
  const find = (s) => ids.find((x) => x === s) || null;

  // ⚠️ Ces patterns peuvent ne pas matcher selon le naming exact des coverageId.
  // On les ajustera après avoir consulté /v1/arome/ids?filter=...
  return {
    rain_1h: find(`TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE__${stamp}_PT1H`),
    gust_1h: find(`WIND_SPEED_GUST_MAX__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__${stamp}_PT1H`),
    pressure_msl: find(`PRESSURE__MEAN_SEA_LEVEL__${stamp}`),
    temp_2m: find(`TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__${stamp}`),
    tmin_2m: find(`MINIMUM_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__${stamp}`),
    tmax_2m: find(`MAXIMUM_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__${stamp}`)
  };
}

// ===== ROUTES =====

// Home
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "CycloneOI AROME API",
    status: "running"
  });
});

// 1) Capabilities XML brut
app.get("/v1/arome/capabilities", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT).trim();
    const url = capabilitiesUrl(run);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.AROME_APIKEY || "",
        accept: "application/xml,text/xml,*/*"
      }
    });

    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
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

// 2) Debug: liste les CoverageId (filtrable)
app.get("/v1/arome/ids", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT).trim();
    const filter = String(req.query.filter || "").trim().toUpperCase();
    const url = capabilitiesUrl(run);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.AROME_APIKEY || "",
        accept: "application/xml,text/xml,*/*"
      }
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: "mf_error",
        status: r.status,
        detail: xml.slice(0, 400)
      });
    }

    const ids = extractCoverageIds(xml);

    const filtered = filter
      ? ids.filter((x) => x.toUpperCase().includes(filter))
      : ids;

    res.json({
      ok: true,
      run,
      filter: filter || null,
      count: filtered.length,
      sample: filtered.slice(0, 200)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "ids_failed",
      message: String(e?.message || e)
    });
  }
});

// 3) Latest run + CoverageIds utiles (JSON)
app.get("/v1/arome/latest", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT).trim();
    const url = capabilitiesUrl(run);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.AROME_APIKEY || "",
        accept: "application/xml,text/xml,*/*"
      }
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: "mf_error",
        status: r.status,
        detail: xml.slice(0, 400)
      });
    }

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    if (!stamp) return res.status(502).json({ ok: false, error: "no_run_stamp_found" });

    const coverage = pickCoverage(ids, stamp);

    res.json({
      ok: true,
      mf: "PE-AROME INDIEN 0.025",
      run,
      latest_run_stamp: stamp,
      formats: ["application/wmo-grib", "image/tiff"],
      coverage
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "latest_failed",
      message: String(e?.message || e)
    });
  }
});

app.listen(PORT, () => console.log("Server listening on port", PORT));
