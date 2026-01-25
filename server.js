import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// bbox Saint-Denis (petite zone)
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
  const base = `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/DescribeCoverage?service=WCS&version=2.0.1`;
  const u = new URL(base);
  // IMPORTANT: coverageId exact, URLSearchParams encode correctement
  u.searchParams.set("coverageId", coverageId);
  return u.toString();
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
    const m = id.match(/___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/) || id.match(/__(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)/);
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

function pickRainPt1h(ids, stamp) {
  // EXACT (issu des IDs)
  return ids.find(x => x.startsWith("TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__") && x.includes(stamp) && x.endsWith("_PT1H")) || null;
}
function pickGustPt1h(ids, stamp) {
  return ids.find(x => x.startsWith("WIND_SPEED_GUST") && x.includes(stamp) && x.endsWith("_PT1H")) || null;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" }
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

// ---- DescribeCoverage parsing (doc MF) ----
// axisLabels="long lat height time" + coefficients pour chaque dimension discrete
function parseAxisLabels(xml) {
  const m = xml.match(/axisLabels="([^"]+)"/);
  if (!m) return null;
  return m[1].trim().split(/\s+/);
}

// coefficients associés à la dimension (ex: <gmlrgrid:gridAxesSpanned>time</...> puis <gmlrgrid:coefficients>3600 7200 ...</...>)
function parseCoefficientsForAxis(xml, axisName) {
  // on récupère le bloc du GeneralGridAxis correspondant à gridAxesSpanned=axisName
  const re = new RegExp(`<gmlrgrid:gridAxesSpanned>\\s*${axisName}\\s*<\\/gmlrgrid:gridAxesSpanned>[\\s\\S]*?<gmlrgrid:coefficients>([\\s\\S]*?)<\\/gmlrgrid:coefficients>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  // split numbers/tokens
  return m[1].trim().split(/\s+/).filter(Boolean);
}

function firstNumeric(coeffs) {
  if (!coeffs) return null;
  for (const c of coeffs) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function resolveCoverage(run, type) {
  // type: "rain" or "gust"
  const cap = await fetchText(capabilitiesUrl(run));
  if (!cap.ok) return { ok: false, status: cap.status, error: "capabilities_failed", detail: cap.text.slice(0, 200) };

  const ids = extractCoverageIds(cap.text);
  const stamp = latestRunStamp(ids);
  if (!stamp) return { ok: false, status: 500, error: "no_run_stamp_found" };

  let coverageId = null;
  if (type === "rain") coverageId = pickRainPt1h(ids, stamp);
  if (type === "gust") coverageId = pickGustPt1h(ids, stamp);

  if (!coverageId) return { ok: false, status: 500, error: "coverage_not_found", stamp };

  // describe
  const desc = await fetchText(describeUrl(run, coverageId));
  if (!desc.ok) return { ok: false, status: desc.status, error: "describe_failed", coverageId, detail: desc.text.slice(0, 300) };

  const axisLabels = parseAxisLabels(desc.text) || [];
  // doc MF: long lat height time
  const hasHeight = axisLabels.includes("height");

  const timeCoeffs = parseCoefficientsForAxis(desc.text, "time");
  const heightCoeffs = hasHeight ? parseCoefficientsForAxis(desc.text, "height") : null;

  // Choix par défaut:
  // - time: premier coefficient (souvent 3600)
  // - height: 10 si dispo, sinon premier
  const timeSeconds = firstNumeric(timeCoeffs) ?? 3600;

  let heightVal = null;
  if (hasHeight) {
    const nums = (heightCoeffs || []).map(x => Number(x)).filter(Number.isFinite);
    heightVal = nums.includes(10) ? 10 : (nums[0] ?? 10);
  }

  return {
    ok: true,
    stamp,
    coverageId,
    axisLabels,
    timeSeconds,
    heightVal
  };
}

async function doGetCoverage({ run, coverageId, format, timeSeconds, heightVal }) {
  const u = new URL(getCoverageBase(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  // doc MF: coverageid (minuscule) dans l’exemple curl → on met les deux pour éviter les implémentations capricieuses
  u.searchParams.set("coverageid", coverageId);
  u.searchParams.set("coverageId", coverageId);
  u.searchParams.set("format", format);

  // doc MF: subset=dimensionA(val1[,val2])
  u.searchParams.append("subset", `long(${BBOX.longMin},${BBOX.longMax})`);
  u.searchParams.append("subset", `lat(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `time(${timeSeconds})`);

  if (heightVal != null) {
    u.searchParams.append("subset", `height(${heightVal})`);
  }

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "", accept: "*/*" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, ct, buf, url: u.toString() };
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

// Debug: voir résolution (coverageId + timeSeconds + height)
app.get("/v1/arome/debug/resolve", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const type = String(req.query.type || "rain");
  const out = await resolveCoverage(run, type);
  res.status(out.ok ? 200 : (out.status || 500)).json(out);
});

// Download pluie PT1H (auto)
app.get("/v1/arome/rain/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const format = String(req.query.format || "image/tiff");

  const info = await resolveCoverage(run, "rain");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const out = await doGetCoverage({
    run,
    coverageId: info.coverageId,
    format,
    timeSeconds: info.timeSeconds,
    heightVal: null
  });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(out.buf);
});

// Download rafales PT1H (auto + height)
app.get("/v1/arome/gust/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const format = String(req.query.format || "image/tiff");

  const info = await resolveCoverage(run, "gust");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const out = await doGetCoverage({
    run,
    coverageId: info.coverageId,
    format,
    timeSeconds: info.timeSeconds,
    heightVal: info.heightVal
  });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(out.buf);
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
