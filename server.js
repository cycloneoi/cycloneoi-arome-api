import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

// Saint-Denis bbox auto (petite zone)
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
  return bestStr; // ex "2026-01-25T00.00.00Z"
}

function defaultValidTimeFromStamp(stamp) {
  // Le WCS refuse souvent 00:00:00Z, il attend 01:00:00Z, 02:00:00Z, ...
  // -> on force 01:00:00Z sur le jour du run
  const d = stamp.slice(0, 10); // "YYYY-MM-DD"
  return `${d}T01:00:00Z`;
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
    p1d: pick("_P1D"),
  };
}

async function fetchCapabilities(run) {
  const r = await fetch(capabilitiesUrl(run), {
    headers: { apikey: process.env.AROME_APIKEY || "" },
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

async function fetchDescribe(run, coverageId) {
  const u = new URL(describeUrl(run));
  u.searchParams.set("coverageId", coverageId);

  const r = await fetch(u.toString(), {
    headers: { apikey: process.env.AROME_APIKEY || "", accept: "application/xml,text/xml,*/*" },
  });
  const xml = await r.text();
  return { ok: r.ok, status: r.status, xml };
}

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

// very simple: if height axis exists, we use 10 (works in most meteo products)
function defaultHeight() {
  return 10;
}

async function wcsGetCoverage({ run, coverageId, format, timeIso, addHeight }) {
  // describe -> axis labels (and detect height axis)
  const d = await fetchDescribe(run, coverageId);
  if (!d.ok) return { status: d.status, ct: "application/xml; charset=utf-8", body: Buffer.from(d.xml) };

  const labels = parseAxisLabels(d.xml);
  if (!labels) return { status: 500, ct: "text/plain; charset=utf-8", body: Buffer.from("Cannot parse axisLabels") };

  const axes = pickAxes(labels);

  const u = new URL(getCoverageUrl(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("coverageId", coverageId);
  u.searchParams.set("format", format);

  // IMPORTANT: correct axis labels (case-sensitive)
  u.searchParams.append("subset", `${axes.lon}(${BBOX.lonMin},${BBOX.lonMax})`);
  u.searchParams.append("subset", `${axes.lat}(${BBOX.latMin},${BBOX.latMax})`);
  u.searchParams.append("subset", `${axes.time}("${timeIso}")`);

  // For gust: if height axis exists, add it
  if (addHeight && axes.height) {
    u.searchParams.append("subset", `${axes.height}(${defaultHeight()})`);
  }

  const r = await fetch(u.toString(), { headers: { apikey: process.env.AROME_APIKEY || "" } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, ct, body: buf };
}

/* =======================
   ROUTES
======================= */

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

// describe debug (coverageId OR id)
app.get("/v1/arome/describe", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const coverageId = String(req.query.coverageId || req.query.id || "");
  if (!coverageId) return res.status(400).json({ ok: false, error: "coverageId_missing" });

  const d = await fetchDescribe(run, coverageId);
  res.status(d.status);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(d.xml);
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

// DOWNLOAD PLUIE (default pt1h + default time=01Z)
app.get("/v1/arome/rain/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);

    const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
    const rain = pickRainIds(precipIds, stamp);

    const coverageId = String(req.query.coverageId || rain.pt1h || "");
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_rain_coverage_found" });

    const timeIso = String(req.query.time || defaultValidTimeFromStamp(stamp));

    const out = await wcsGetCoverage({
      run,
      coverageId,
      format,
      timeIso,
      addHeight: false
    });

    res.status(out.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.ct);
    res.send(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_download_failed", message: String(e?.message || e) });
  }
});

// DOWNLOAD RAFALES (default pt1h + default time=01Z + height si demandé)
app.get("/v1/arome/gust/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const format = String(req.query.format || "image/tiff");

    const { ok, status, xml } = await fetchCapabilities(run);
    if (!ok) return res.status(502).json({ ok: false, mf_status: status });

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);

    const gustIds = ids.filter((x) => x.includes("GUST"));
    const gust = pickGustIds(gustIds, stamp);

    const coverageId = String(req.query.coverageId || gust.pt1h || "");
    if (!coverageId) return res.status(500).json({ ok: false, error: "no_gust_coverage_found" });

    const timeIso = String(req.query.time || defaultValidTimeFromStamp(stamp));

    const out = await wcsGetCoverage({
      run,
      coverageId,
      format,
      timeIso,
      addHeight: true
    });

    res.status(out.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.ct);
    res.send(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "gust_download_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
