import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// bbox Saint-Denis
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

function getCoverageBase(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCoverage`;
}

function describeBase(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/DescribeCoverage?service=WCS&version=2.0.1`;
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

function defaultValidTimeFromStamp(stamp) {
  // le WCS refuse souvent 00Z, on force 01Z
  const d = stamp.slice(0, 10);
  return `${d}T01:00:00Z`;
}

function pickRainIds(ids, stamp) {
  const byStamp = ids.filter((x) => x.includes(`__${stamp}_`));
  const pick = (suffix) =>
    byStamp.find((x) =>
      x.startsWith("TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__") &&
      x.endsWith(suffix)
    ) || null;

  return { pt1h: pick("_PT1H") };
}

function pickGustIds(ids, stamp) {
  const byStamp = ids.filter((x) => x.includes(`__${stamp}_`));
  const pick = (suffix) =>
    byStamp.find((x) =>
      x.startsWith("WIND_SPEED_GUST_MAX__") &&
      x.endsWith(suffix)
    ) || null;

  return { pt1h: pick("_PT1H") };
}

async function fetchCapabilities(run) {
  const r = await fetch(capabilitiesUrl(run), {
    headers: { apikey: process.env.AROME_APIKEY || "" }
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

// ✅ DescribeCoverage corrigé : on URL-encode le coverageId correctement
app.get("/v1/arome/describe", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const coverageId = String(req.query.coverageId || req.query.id || "");
  if (!coverageId) return res.status(400).json({ ok: false, error: "coverageId_missing" });

  const u = new URL(describeBase(run));
  u.searchParams.set("coverageId", coverageId); // URLSearchParams encode correctement

  const r = await fetch(u.toString(), {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" }
  });

  const xml = await r.text();
  res.status(r.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(xml);
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

// Download pluie (par défaut pt1h + time valide) — axes: lon/lat/time (minuscules)
app.get("/v1/arome/rain/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || defaultValidTimeFromStamp(stamp));

    // coverageId default pt1h
    const rain = pickRainIds(ids.filter(x => x.includes("PRECIPITATION")), stamp);
    const coverageId = String(req.query.coverageId || rain.pt1h || "");
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_rain_pt1h_found" });

    const u = new URL(getCoverageBase(run));
    u.searchParams.set("service", "WCS");
    u.searchParams.set("version", "2.0.1");
    u.searchParams.set("request", "GetCoverage");
    u.searchParams.set("coverageId", coverageId);
    u.searchParams.set("format", format);

    // ✅ axes en minuscules
    u.searchParams.append("subset", `lon(${BBOX.lonMin},${BBOX.lonMax})`);
    u.searchParams.append("subset", `lat(${BBOX.latMin},${BBOX.latMax})`);
    u.searchParams.append("subset", `time("${timeIso}")`);

    const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type") || "application/octet-stream";

    res.status(r.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_download_failed", message: String(e?.message || e) });
  }
});

// Download rafales (par défaut pt1h + time valide) — axes lon/lat/time + height(10)
app.get("/v1/arome/gust/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || defaultValidTimeFromStamp(stamp));

    const gust = pickGustIds(ids.filter(x => x.includes("GUST")), stamp);
    const coverageId = String(req.query.coverageId || gust.pt1h || "");
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_gust_pt1h_found" });

    const u = new URL(getCoverageBase(run));
    u.searchParams.set("service", "WCS");
    u.searchParams.set("version", "2.0.1");
    u.searchParams.set("request", "GetCoverage");
    u.searchParams.set("coverageId", coverageId);
    u.searchParams.set("format", format);

    u.searchParams.append("subset", `lon(${BBOX.lonMin},${BBOX.lonMax})`);
    u.searchParams.append("subset", `lat(${BBOX.latMin},${BBOX.latMax})`);
    u.searchParams.append("subset", `time("${timeIso}")`);
    // ✅ height requis pour gust — valeur 10m
    u.searchParams.append("subset", `height(${10})`);

    const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get("content-type") || "application/octet-stream";

    res.status(r.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", ct);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: "gust_download_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
