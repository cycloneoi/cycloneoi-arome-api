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

function describeUrl(run) {
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

function toIsoFromStamp(stamp) {
  // "2026-01-25T00.00.00Z" -> "2026-01-25T00:00:00Z"
  return stamp.replace(/\./g, ":");
}

// ---- NEW: parse axis labels from DescribeCoverage ----
// We try to extract axis labels from gml:axisLabels (most common)
function parseAxisLabels(describeXml) {
  // ex: <gml:axisLabels>lon lat time</gml:axisLabels>
  const m = describeXml.match(/<gml:axisLabels>([^<]+)<\/gml:axisLabels>/);
  if (!m) return null;
  const labels = m[1].trim().split(/\s+/).filter(Boolean);
  return labels.length ? labels : null;
}

function pickSpatialAxis(labels) {
  // Most services use lon/lat, Long/Lat, x/y. We'll pick best guess.
  const lower = labels.map(x => x.toLowerCase());
  const lonIdx = lower.findIndex(x => x === "lon" || x === "long" || x === "longitude" || x === "x");
  const latIdx = lower.findIndex(x => x === "lat" || x === "latitude" || x === "y");
  const timeIdx = lower.findIndex(x => x === "time" || x === "t");

  if (lonIdx !== -1 && latIdx !== -1) {
    return {
      lonLabel: labels[lonIdx],
      latLabel: labels[latIdx],
      timeLabel: timeIdx !== -1 ? labels[timeIdx] : "time"
    };
  }

  // fallback: assume first two are spatial, last is time
  if (labels.length >= 2) {
    return {
      lonLabel: labels[0],
      latLabel: labels[1],
      timeLabel: labels[2] || "time"
    };
  }

  return null;
}

async function describeCoverage(run, coverageId) {
  const u = new URL(describeUrl(run));
  u.searchParams.set("coverageId", coverageId);

  const r = await fetch(u.toString(), {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" }
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

async function wcsDownload({ run, coverageId, timeIso, format }) {
  // 1) describe to get axis labels
  const d = await describeCoverage(run, coverageId);
  if (!d.ok) {
    return { ok: false, status: 502, body: Buffer.from(d.xml), contentType: "application/xml" };
  }

  const labels = parseAxisLabels(d.xml);
  if (!labels) {
    return { ok: false, status: 500, body: Buffer.from("Cannot parse axis labels"), contentType: "text/plain" };
  }

  const axes = pickSpatialAxis(labels);
  if (!axes) {
    return { ok: false, status: 500, body: Buffer.from("Cannot determine spatial axes"), contentType: "text/plain" };
  }

  // 2) build GetCoverage with correct axis labels (case-sensitive!)
  const u = new URL(getCoverageBase(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("coverageId", coverageId);
  u.searchParams.set("format", format);

  u.searchParams.append("subset", `${axes.lonLabel}(${BBOX.lonMin},${BBOX.lonMax})`);
  u.searchParams.append("subset", `${axes.latLabel}(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `${axes.timeLabel}("${timeIso}")`);

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "application/octet-stream";

  return { ok: r.ok, status: r.status, body: buf, contentType: ct };
}

// ===== Routes =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

app.get("/v1/arome/capabilities", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const r = await fetch(capabilitiesUrl(run), { headers: { apikey: process.env.AROME_APIKEY || "" } });
  const text = await r.text();
  res.status(r.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(text);
});

app.get("/v1/arome/ids", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const filter = String(req.query.filter || "").toUpperCase();
  const { ok, status, xml } = await fetchCapabilities(run);
  if (!ok) return res.status(502).json({ ok: false, mf_status: status });

  const ids = extractCoverageIds(xml);
  const filtered = filter ? ids.filter((x) => x.toUpperCase().includes(filter)) : ids;
  res.json({ ok: true, run, filter: filter || null, count: filtered.length, sample: filtered.slice(0, 200) });
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

// NEW: DescribeCoverage passthrough (debug)
app.get("/v1/arome/describe", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const coverageId = String(req.query.coverageId || "");
  if (!coverageId) return res.status(400).json({ ok: false, error: "coverageId_missing" });

  const d = await describeCoverage(run, coverageId);
  res.status(d.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(d.xml);
});

// DOWNLOAD pluie
app.get("/v1/arome/rain/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || toIsoFromStamp(stamp));

    let coverageId = req.query.coverageId;
    if (!coverageId) {
      const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
      const rain = pickRainIds(precipIds, stamp);
      coverageId = rain.pt1h;
    }
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_rain_coverage_found" });

    const out = await wcsDownload({ run, coverageId, timeIso, format });
    res.status(out.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_download_failed", message: String(e?.message || e) });
  }
});

// DOWNLOAD rafales
app.get("/v1/arome/gust/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    const timeIso = String(req.query.time || toIsoFromStamp(stamp));

    let coverageId = req.query.coverageId;
    if (!coverageId) {
      const gustIds = ids.filter((x) => x.includes("GUST"));
      const gust = pickGustIds(gustIds, stamp);
      coverageId = gust.pt1h;
    }
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_gust_coverage_found" });

    const out = await wcsDownload({ run, coverageId, timeIso, format });
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
