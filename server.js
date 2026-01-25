import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// Saint-Denis (bbox auto)
const SDN = { lat: -20.8789, lon: 55.4481 };
// bbox ~ +/- 0.08° (~9 km). Ajustable
const BBOX = {
  lonMin: SDN.lon - 0.08,
  lonMax: SDN.lon + 0.08,
  latMin: SDN.lat - 0.08,
  latMax: SDN.lat + 0.08,
};

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}

function getCoverageBase(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCoverage`;
}

function extractCoverageIds(xml) {
  const ids = [];
  const re = /<wcs:CoverageId>([^<]+)<\/wcs:CoverageId>/g;
  let m;
  while ((m = re.exec(xml))) ids.push(m[1]);
  return ids;
}

function latestRunStamp(ids) {
  let bestTs = null;
  let bestStr = null;
  for (const id of ids) {
    const m = id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/);
    if (!m) continue;
    const iso = m[1].replace(/\./g, ":");
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (bestTs === null || ts > bestTs) {
      bestTs = ts;
      bestStr = m[1];
    }
  }
  return bestStr;
}

function pickRainIds(ids, stamp) {
  const byStamp = ids.filter((x) => x.includes(`__${stamp}_`));
  const pick = (suffix) =>
    byStamp.find((x) =>
      x.startsWith("TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__") &&
      x.endsWith(suffix)
    ) || null;

  return {
    pt1h: pick("_PT1H"),
    pt3h: pick("_PT3H"),
    pt6h: pick("_PT6H"),
    pt12h: pick("_PT12H"),
    p1d: pick("_P1D"),
    p2d: pick("_P2D"),
  };
}

function pickGustIds(ids, stamp) {
  const byStamp = ids.filter((x) => x.includes(`__${stamp}_`));
  const pick = (suffix) =>
    byStamp.find((x) =>
      x.startsWith("WIND_SPEED_GUST_MAX__") &&
      x.endsWith(suffix)
    ) || null;

  return {
    pt1h: pick("_PT1H"),
    pt3h: pick("_PT3H"),
    pt6h: pick("_PT6H"),
    pt12h: pick("_PT12H"),
    p1d: pick("_P1D")
  };
}

async function fetchCapabilities(run) {
  const r = await fetch(capabilitiesUrl(run), {
    headers: { apikey: process.env.AROME_APIKEY || "" },
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

function computeDefaultTimeZ(latestStamp) {
  // latestStamp: "2026-01-25T00.00.00Z"
  // on renvoie la même date, format WCS time("YYYY-MM-DDTHH:MM:SSZ")
  const iso = latestStamp.replace(/\./g, ":"); // "2026-01-25T00:00:00Z"
  return iso;
}

// ===== Routes =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

// Capabilities XML brut
app.get("/v1/arome/capabilities", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const r = await fetch(capabilitiesUrl(run), {
    headers: { apikey: process.env.AROME_APIKEY || "" },
  });
  const text = await r.text();
  res.status(r.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(text);
});

// Debug ids
app.get("/v1/arome/ids", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const filter = String(req.query.filter || "").toUpperCase();

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const filtered = filter ? ids.filter((x) => x.toUpperCase().includes(filter)) : ids;

    res.json({ ok: true, run, filter: filter || null, count: filtered.length, sample: filtered.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Pluie latest
app.get("/v1/arome/rain/latest", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
    const rain = pickRainIds(precipIds, stamp);

    res.json({ ok: true, run, latest_run_stamp: stamp, rain });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Rafales latest
app.get("/v1/arome/gust/latest", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const gustIds = ids.filter((x) => x.includes("GUST"));
    const gust = pickGustIds(gustIds, stamp);

    res.json({ ok: true, run, latest_run_stamp: stamp, gust });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ====== DOWNLOAD (subset auto) ======
// Params:
//  - run=001
//  - coverageId=... (sinon on prend pt1h auto)
//  - time=YYYY-MM-DDTHH:MM:SSZ (sinon time = latest_run_stamp)
//  - format=image/tiff (defaut) ou application/wmo-grib

async function wcsDownload({ run, coverageId, timeIso, format }) {
  const u = new URL(getCoverageBase(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("coverageId", coverageId);
  u.searchParams.set("format", format);

  // subset obligatoire
  u.searchParams.append("subset", `Long(${BBOX.lonMin},${BBOX.lonMax})`);
  u.searchParams.append("subset", `Lat(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `time("${timeIso}")`);

  const r = await fetch(u.toString(), {
    headers: { apikey: process.env.AROME_APIKEY || "" },
  });

  return r;
}

// Pluie download (par défaut pt1h)
app.get("/v1/arome/rain/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || computeDefaultTimeZ(stamp));

    // si l'utilisateur donne un coverageId, on le prend ; sinon pt1h auto
    let coverageId = req.query.coverageId;
    if (!coverageId) {
      const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
      const rain = pickRainIds(precipIds, stamp);
      coverageId = rain.pt1h;
      if (!coverageId) return res.status(500).json({ ok: false, error: "no_rain_pt1h_found" });
    }

    const r = await wcsDownload({ run, coverageId, timeIso, format });

    res.status(r.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");

    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_download_failed", message: String(e?.message || e) });
  }
});

// Rafales download (par défaut pt1h)
app.get("/v1/arome/gust/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || computeDefaultTimeZ(stamp));

    let coverageId = req.query.coverageId;
    if (!coverageId) {
      const gustIds = ids.filter((x) => x.includes("GUST"));
      const gust = pickGustIds(gustIds, stamp);
      coverageId = gust.pt1h;
      if (!coverageId) return res.status(500).json({ ok: false, error: "no_gust_pt1h_found" });
    }

    const r = await wcsDownload({ run, coverageId, timeIso, format });

    res.status(r.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");

    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: "gust_download_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
