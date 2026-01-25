import express from "express";
import { fromArrayBuffer } from "geotiff";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// Point ville (Saint-Denis)
const CITY = { lat: -20.8789, lon: 55.4481 };

// bbox (WCS) : bbox autour de la ville
// NOTE: 5 km ~ 0.045° en latitude ; en longitude dépend de la latitude (~0.048° à -21°)
function bboxFromRadiusKm(lat, lon, rKm) {
  const dLat = rKm / 111.0;
  const dLon = rKm / (111.0 * Math.cos((Math.abs(lat) * Math.PI) / 180));
  return {
    longMin: lon - dLon,
    longMax: lon + dLon,
    latMin: lat - dLat,
    latMax: lat + dLat
  };
}

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
}
function describeUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/DescribeCoverage?service=WCS&version=2.0.1`;
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

async function resolve(run, type) {
  const cap = await fetchText(capabilitiesUrl(run));
  if (!cap.ok) return { ok:false, status: cap.status, error:"capabilities_failed", detail: cap.text.slice(0,200) };

  const ids = extractCoverageIds(cap.text);
  const stamp = latestRunStamp(ids);
  if (!stamp) return { ok:false, status:500, error:"no_run_stamp_found" };

  let coverageId = null;
  if (type === "rain") coverageId = pickRainPt1h(ids, stamp);
  if (type === "gust") coverageId = pickGustPt1h(ids, stamp);
  if (!coverageId) return { ok:false, status:500, error:"coverage_not_found", stamp };

  const du = new URL(describeUrl(run));
  du.searchParams.set("coverageId", coverageId);
  const desc = await fetchText(du.toString());
  if (!desc.ok) return { ok:false, status: desc.status, error:"describe_failed", coverageId, detail: desc.text.slice(0,300) };

  const axisLabels = parseAxisLabels(desc.text);
  const timeCoeffs = parseCoefficientsForAxis(desc.text, "time");
  const timeSeconds = firstNumber(timeCoeffs, 3600);

  let heightVal = null;
  if (axisLabels.includes("height")) {
    const heightCoeffs = parseCoefficientsForAxis(desc.text, "height");
    // ton service: uniquement 10
    heightVal = 10;
    const _h = firstNumber(heightCoeffs, 10);
    if (Number.isFinite(_h)) heightVal = 10;
  }

  return { ok:true, stamp, coverageId, timeSeconds, heightVal, axisLabels };
}

async function getCoverageTiff({ run, coverageId, timeSeconds, heightVal, bbox }) {
  const u = new URL(getCoverageUrl(run));
  u.searchParams.set("service","WCS");
  u.searchParams.set("version","2.0.1");
  u.searchParams.set("request","GetCoverage");
  u.searchParams.set("coverageid", coverageId);
  u.searchParams.set("format", "image/tiff");

  u.searchParams.append("subset", `long(${bbox.longMin},${bbox.longMax})`);
  u.searchParams.append("subset", `lat(${bbox.latMin},${bbox.latMax})`);
  u.searchParams.append("subset", `time(${timeSeconds})`);
  if (heightVal != null) u.searchParams.append("subset", `height(${heightVal})`);

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "", accept: "*/*" } });
  const buf = await r.arrayBuffer();
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, ct, buf };
}

// lit un GeoTIFF et renvoie le max d’une grille d’échantillonnage 5x5
async function maxFromGeoTiff(arrayBuffer) {
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  const samples = 5;
  let max = -Infinity;

  for (let yi = 0; yi < samples; yi++) {
    for (let xi = 0; xi < samples; xi++) {
      const x = Math.round((xi / (samples - 1)) * (width - 1));
      const y = Math.round((yi / (samples - 1)) * (height - 1));
      const ras = await image.readRasters({ window: [x, y, x + 1, y + 1] });
      const v = ras?.[0]?.[0];
      if (Number.isFinite(v)) max = Math.max(max, v);
    }
  }

  if (!Number.isFinite(max)) return null;
  return max;
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

// debug resolve
app.get("/v1/arome/debug/resolve", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const type = String(req.query.type || "rain");
  const out = await resolve(run, type);
  res.status(out.ok ? 200 : (out.status || 500)).json(out);
});

// download TIFF (bbox 5km)
app.get("/v1/arome/rain/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolve(run, "rain");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, 5);
  const out = await getCoverageTiff({ run, coverageId: info.coverageId, timeSeconds: info.timeSeconds, heightVal: null, bbox });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(Buffer.from(out.buf));
});

app.get("/v1/arome/gust/download", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolve(run, "gust");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, 5);
  const out = await getCoverageTiff({ run, coverageId: info.coverageId, timeSeconds: info.timeSeconds, heightVal: 10, bbox });

  res.status(out.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Content-Type", out.ct);
  res.send(Buffer.from(out.buf));
});

// valeur locale (max) sur bbox 5 km
app.get("/v1/arome/rain/value", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolve(run, "rain");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const radiusKm = Math.max(1, Math.min(10, parseFloat(req.query.radius_km || "5") || 5));
  const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, radiusKm);
  const cov = await getCoverageTiff({ run, coverageId: info.coverageId, timeSeconds: info.timeSeconds, heightVal: null, bbox });

  if (cov.status < 200 || cov.status >= 300) {
    return res.status(cov.status).json({ ok:false, error:"download_failed", status: cov.status });
  }

  const maxVal = await maxFromGeoTiff(cov.buf);
  res.json({
    ok: true,
    type: "rain",
    run,
    coverageId: info.coverageId,
    timeSeconds: info.timeSeconds,
    radius_km: radiusKm,
    max_mm: maxVal
  });
});

app.get("/v1/arome/gust/value", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const info = await resolve(run, "gust");
  if (!info.ok) return res.status(info.status || 500).json(info);

  const radiusKm = Math.max(1, Math.min(10, parseFloat(req.query.radius_km || "5") || 5));
  const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, radiusKm);
  const cov = await getCoverageTiff({ run, coverageId: info.coverageId, timeSeconds: info.timeSeconds, heightVal: 10, bbox });

  if (cov.status < 200 || cov.status >= 300) {
    return res.status(cov.status).json({ ok:false, error:"download_failed", status: cov.status });
  }

  const maxVal = await maxFromGeoTiff(cov.buf);
  res.json({
    ok: true,
    type: "gust",
    run,
    coverageId: info.coverageId,
    timeSeconds: info.timeSeconds,
    height: 10,
    radius_km: radiusKm,
    max_value: maxVal,
    max_kmh: (Number.isFinite(maxVal) ? maxVal * 3.6 : null)
  });
});

// ✅ NOUVEAU : SERIES 0–48h (ou param hours) — max bbox
app.get("/v1/arome/rain/series", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const hours = Math.max(1, Math.min(48, parseInt(req.query.hours || "48", 10) || 48));
    const radiusKm = Math.max(1, Math.min(10, parseFloat(req.query.radius_km || "5") || 5));

    const info = await resolve(run, "rain");
    if (!info.ok) return res.status(info.status || 500).json(info);

    const step = Number(info.timeSeconds); // 3600
    const steps = Math.floor((hours * 3600) / step);

    const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, radiusKm);

    const series = [];
    for (let i = 1; i <= steps; i++) {
      const tSec = i * step;

      const cov = await getCoverageTiff({
        run,
        coverageId: info.coverageId,
        timeSeconds: tSec,
        heightVal: null,
        bbox
      });

      if (cov.status < 200 || cov.status >= 300) {
        series.push({ t_seconds: tSec, ok: false, error: `download_${cov.status}` });
        continue;
      }

      const maxVal = await maxFromGeoTiff(cov.buf);
      series.push({ t_seconds: tSec, ok: true, max_mm: maxVal });
    }

    res.json({
      ok: true,
      type: "rain",
      run,
      coverageId: info.coverageId,
      step_seconds: step,
      hours,
      radius_km: radiusKm,
      series
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_series_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/gust/series", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const hours = Math.max(1, Math.min(48, parseInt(req.query.hours || "48", 10) || 48));
    const radiusKm = Math.max(1, Math.min(10, parseFloat(req.query.radius_km || "5") || 5));

    const info = await resolve(run, "gust");
    if (!info.ok) return res.status(info.status || 500).json(info);

    const step = Number(info.timeSeconds); // 3600
    const steps = Math.floor((hours * 3600) / step);

    const bbox = bboxFromRadiusKm(CITY.lat, CITY.lon, radiusKm);

    const series = [];
    for (let i = 1; i <= steps; i++) {
      const tSec = i * step;

      const cov = await getCoverageTiff({
        run,
        coverageId: info.coverageId,
        timeSeconds: tSec,
        heightVal: 10,
        bbox
      });

      if (cov.status < 200 || cov.status >= 300) {
        series.push({ t_seconds: tSec, ok: false, error: `download_${cov.status}` });
        continue;
      }

      const maxVal = await maxFromGeoTiff(cov.buf); // probable m/s
      series.push({
        t_seconds: tSec,
        ok: true,
        max_ms: maxVal,
        max_kmh: (Number.isFinite(maxVal) ? maxVal * 3.6 : null)
      });
    }

    res.json({
      ok: true,
      type: "gust",
      run,
      coverageId: info.coverageId,
      height: 10,
      step_seconds: step,
      hours,
      radius_km: radiusKm,
      series
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "gust_series_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
