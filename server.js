import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// bbox Saint-Denis
const SDN = { lat: -20.8789, lon: 55.4481 };
const BBOX = {
  longMin: SDN.lon - 0.08,
  longMax: SDN.lon + 0.08,
  latMin: SDN.lat - 0.08,
  latMax: SDN.lat + 0.08,
};

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}
function describeUrl(run, coverageId) {
  const u = new URL(`${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/DescribeCoverage?service=WCS&version=2.0.1`);
  u.searchParams.set("coverageId", coverageId);
  return u.toString();
}
function getCoverageUrl(run) {
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
    const m = id.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/) || id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/);
    if (!m) continue;
    const iso = m[1].replace(/\./g, ":");
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (bestTs === null || ts > bestTs) { bestTs = ts; bestStr = m[1]; }
  }
  return bestStr;
}

function pickRainPt1h(ids, stamp) {
  return ids.find(x =>
    x.startsWith("TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__") &&
    x.includes(stamp) &&
    x.endsWith("_PT1H")
  ) || null;
}

function pickGustPt1h(ids, stamp) {
  return ids.find(x =>
    x.startsWith("WIND_SPEED_GUST_MAX__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__") &&
    x.includes(stamp) &&
    x.endsWith("_PT1H")
  ) || null;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" }
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

// axisLabels="long lat height time"
function parseAxisLabels(xml) {
  const m = xml.match(/axisLabels="([^"]+)"/);
  if (!m) return [];
  return m[1].trim().split(/\s+/);
}

// ✅ IMPORTANT: on récupère les coefficients du BON axe (height ou time)
function parseCoefficientsForAxis(xml, axisName) {
  const re = new RegExp(
    `<gmlrgrid:gridAxesSpanned>\\s*${axisName}\\s*<\\/gmlrgrid:gridAxesSpanned>[\\s\\S]*?<gmlrgrid:coefficients>([\\s\\S]*?)<\\/gmlrgrid:coefficients>`,
    "i"
  );
  const m = xml.match(re);
  if (!m) return null;
  return m[1].trim().split(/\s+/).filter(Boolean);
}

function firstNumber(list, fallback) {
  if (!list) return fallback;
  for (const v of list) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

async function resolveCoverage(run, type) {
  // 1) Capabilities
  const cap = await fetchText(capabilitiesUrl(run));
  if (!cap.ok) return { ok: false, status: cap.status, error: "capabilities_failed", detail: cap.text.slice(0, 200) };

  const ids = extractCoverageIds(cap.text);
  const stamp = latestRunStamp(ids);
  if (!stamp) return { ok: false, status: 500, error: "no_run_stamp_found" };

  let coverageId = null;
  if (type === "rain") coverageId = pickRainPt1h(ids, stamp);
  if (type === "gust") coverageId = pickGustPt1h(ids, stamp);
  if (!coverageId) return { ok: false, status: 500, error: "coverage_not_found", stamp };

  // 2) DescribeCoverage
  const desc = await fetchText(describeUrl(run, coverageId));
  if (!desc.ok) return { ok: false, status: desc.status, error: "describe_failed", coverageId, detail: desc.text.slice(0, 300) };

  const axisLabels = parseAxisLabels(desc.text);
  const timeCoeffs = parseCoefficientsForAxis(desc.text, "time");
  const timeSeconds = firstNumber(timeCoeffs, 3600);

  let heightVal = null;
  if (axisLabels.includes("height")) {
    const heightCoeffs = parseCoefficientsForAxis(desc.text, "height");
    // doc + ton erreur: height must be in : 10
    const h = firstNumber(heightCoeffs, 10);
    heightVal = Number.isFinite(h) ? h : 10;
  }

  return { ok: true, stamp, coverageId, axisLabels, timeSeconds, heightVal };
}

async function doGetCoverage({ run, coverageId, timeSeconds, heightVal }) {
  const u = new URL(getCoverageUrl(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  // doc MF: coverageid (minuscule) recommandé
  u.searchParams.set("coverageid", coverageId);
  u.searchParams.set("format", "image/tiff");

  u.searchParams.append("subset", `long(${BBOX.longMin},${BBOX.longMax})`);
  u.searchParams.append("subset", `lat(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `time(${timeSeconds})`);

  if (heightVal != null) {
    u.searchParams.append("subset", `height(${heightVal})`);
  }

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "", accept: "*/*" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, ct, buf };
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

app.get("/v1/arome/debug/resolve", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const type = String(req.query.type || "rain");
  const out = await resolveCoverage(run, type);
  res.status(out.ok ? 200 : (out.status || 500)).json(out);
});

app.get("/v1/arome/rain/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolveCoverage(run, "rain");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const out = await doGetCoverage({
    run,
    coverageId: info.coverageId,
    timeSeconds: info.timeSeconds,
    heightVal: null
  });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(out.buf);
});

app.get("/v1/arome/gust/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolveCoverage(run, "gust");
  if (!info.ok) return res.status(info.status || 500).json(info);

  // ✅ FORCÉ sur 10 si jamais le parse renvoie n'importe quoi (ce qui t'est arrivé)
  const heightSafe = 10;

  const out = await doGetCoverage({
    run,
    coverageId: info.coverageId,
    timeSeconds: info.timeSeconds,
    heightVal: heightSafe
  });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(out.buf);
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
