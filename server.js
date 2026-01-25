import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// Saint-Denis bbox auto
const SDN = { lat: -20.8789, lon: 55.4481 };
const BBOX = {
  lonMin: SDN.lon - 0.08,
  lonMax: SDN.lon + 0.08,
  latMin: SDN.lat - 0.08,
  latMax: SDN.lat + 0.08,
};

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}
function describeBase(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/DescribeCoverage?service=WCS&version=2.0.1`;
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

async function describeCoverage(run, coverageId) {
  const u = new URL(describeBase(run));
  u.searchParams.set("coverageId", coverageId);
  const r = await fetch(u.toString(), {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" }
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

// ---- Parse axis labels ----
function parseAxisLabels(xml) {
  const m = xml.match(/<gml:axisLabels>([^<]+)<\/gml:axisLabels>/);
  if (!m) return null;
  return m[1].trim().split(/\s+/).filter(Boolean);
}
function pickAxes(labels) {
  const lower = labels.map(x => x.toLowerCase());
  const lonIdx = lower.findIndex(x => ["lon","long","longitude","x"].includes(x));
  const latIdx = lower.findIndex(x => ["lat","latitude","y"].includes(x));
  const timeIdx = lower.findIndex(x => x === "time" || x === "t");
  const heightIdx = lower.findIndex(x => x.includes("height") || x === "z");

  return {
    lon: lonIdx !== -1 ? labels[lonIdx] : labels[0],
    lat: latIdx !== -1 ? labels[latIdx] : labels[1],
    time: timeIdx !== -1 ? labels[timeIdx] : "time",
    height: heightIdx !== -1 ? labels[heightIdx] : null
  };
}

// ---- Extract allowed times from MF error list OR DescribeCoverage ----
// On parse une liste ISO dans le XML (DescribeCoverage contient souvent un gml:TimePeriod,
// mais MF te donne aussi explicitement la liste en erreur. On va faire simple: chercher tous les ISO times)
function extractIsoTimes(xml) {
  const times = new Set();
  const re = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/g;
  let m;
  while ((m = re.exec(xml))) times.add(m[1]);
  return Array.from(times).sort();
}

// ---- Extract allowed heights (numbers) ----
function extractHeights(xml) {
  // cherche des nombres "10" "2" etc près de height; c'est simple mais suffisant ici
  const nums = new Set();
  const re = /(\d+(\.\d+)?)/g;
  let m;
  while ((m = re.exec(xml))) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 0 && v <= 200) nums.add(v);
  }
  // on garde des valeurs plausibles et petites en priorité
  return Array.from(nums).sort((a,b)=>a-b).slice(0, 20);
}

async function wcsDownload({ run, coverageId, format, timeIsoOpt }) {
  // 1) DescribeCoverage -> axes + options
  const d = await describeCoverage(run, coverageId);
  if (!d.ok) {
    return { status: d.status, contentType: "application/xml; charset=utf-8", body: Buffer.from(d.xml) };
  }

  const labels = parseAxisLabels(d.xml);
  if (!labels) {
    return { status: 500, contentType: "text/plain; charset=utf-8", body: Buffer.from("Cannot parse axisLabels") };
  }
  const axes = pickAxes(labels);

  // 2) choisir un time valide
  const times = extractIsoTimes(d.xml);
  // si DescribeCoverage ne contient pas les times, on prend un fallback (mais en général il y en a)
  const timeIso = timeIsoOpt || (times[0] || null);
  if (!timeIso) {
    return { status: 500, contentType: "text/plain; charset=utf-8", body: Buffer.from("No time values found in DescribeCoverage") };
  }

  // 3) si height est requis, choisir une hauteur
  let heightVal = null;
  if (axes.height) {
    const hs = extractHeights(d.xml);
    // en général 10m
    heightVal = hs.includes(10) ? 10 : (hs[0] ?? 10);
  }

  // 4) construire GetCoverage
  const u = new URL(getCoverageBase(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("coverageId", coverageId);
  u.searchParams.set("format", format);

  u.searchParams.append("subset", `${axes.lon}(${BBOX.lonMin},${BBOX.lonMax})`);
  u.searchParams.append("subset", `${axes.lat}(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `${axes.time}("${timeIso}")`);

  if (axes.height) {
    u.searchParams.append("subset", `${axes.height}(${heightVal})`);
  }

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, contentType: ct, body: buf, debug: { axes, timeIso, heightVal } };
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

app.get("/v1/arome/rain/latest", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const { ok, status, xml } = await fetchCapabilities(run);
  if (!ok) return res.status(502).json({ ok: false, mf_status: status });

  const ids = extractCoverageIds(xml);
  const stamp = latestRunStamp(ids);
  const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
  const rain = pickRainIds(precipIds, stamp);
  res.json({ ok: true, run, latest_run_stamp: stamp, rain });
});

app.get("/v1/arome/gust/latest", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const { ok, status, xml } = await fetchCapabilities(run);
  if (!ok) return res.status(502).json({ ok: false, mf_status: status });

  const ids = extractCoverageIds(xml);
  const stamp = latestRunStamp(ids);
  const gustIds = ids.filter((x) => x.includes("GUST"));
  const gust = pickGustIds(gustIds, stamp);
  res.json({ ok: true, run, latest_run_stamp: stamp, gust });
});

// DescribeCoverage debug (accept coverageId OR id)
app.get("/v1/arome/describe", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const coverageId = String(req.query.coverageId || req.query.id || "");
  if (!coverageId) return res.status(400).json({ ok: false, error: "coverageId_missing" });

  const d = await describeCoverage(run, coverageId);
  res.status(d.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(d.xml);
});

// Download pluie (pt1h par défaut) + time optionnel
app.get("/v1/arome/rain/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");
    const time = req.query.time ? String(req.query.time) : null;

    // coverageId default = pt1h
    const latest = await fetch(`http://127.0.0.1:${PORT}/v1/arome/rain/latest?run=${encodeURIComponent(run)}`).then(r => r.json());
    const coverageId = String(req.query.coverageId || latest?.rain?.pt1h || "");

    if (!coverageId) return res.status(500).json({ ok: false, error: "no_rain_coverage_found" });

    const out = await wcsDownload({ run, coverageId, format, timeIsoOpt: time });

    res.status(out.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_download_failed", message: String(e?.message || e) });
  }
});

// Download rafales (pt1h par défaut) + time optionnel
app.get("/v1/arome/gust/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");
    const time = req.query.time ? String(req.query.time) : null;

    const latest = await fetch(`http://127.0.0.1:${PORT}/v1/arome/gust/latest?run=${encodeURIComponent(run)}`).then(r => r.json());
    const coverageId = String(req.query.coverageId || latest?.gust?.pt1h || "");

    if (!coverageId) return res.status(500).json({ ok: false, error: "no_gust_coverage_found" });

    const out = await wcsDownload({ run, coverageId, format, timeIsoOpt: time });

    res.status(out.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "gust_download_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
