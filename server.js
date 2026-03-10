import express from "express";
import { fromArrayBuffer } from "geotiff";

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================================
// CONFIG GÉNÉRALE
// ========================================================

const RUN_DEFAULT = "001";
const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 10;
const DEFAULT_HOURS = 48;
const MAX_HOURS = 48;

// Fallback historique si aucun city/lat/lon n'est fourni
const FALLBACK_POINT = {
  slug: "saint-denis",
  label: "Saint Denis",
  lat: -20.8789,
  lon: 55.4481,
};

// Source des lieux depuis ton worker premium
const PLACES_SOURCE_URL =
  "https://cycloneoi-premium.patrick-rabeson.workers.dev/v1/locations?resolve=1";

const PLACES_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let placesCache = {
  ts: 0,
  data: null,
};

// ========================================================
// URLS WCS AROME
// ========================================================

// Adapte ces URLs si ton endpoint WCS réel diffère
function capabilitiesUrl(run) {
  return `https://public-api.meteofrance.fr/public/arome/1.0/wcs/METADATA?service=WCS&version=2.0.1&request=GetCapabilities`;
}

function describeUrl(run) {
  return `https://public-api.meteofrance.fr/public/arome/1.0/wcs/METADATA?service=WCS&version=2.0.1&request=DescribeCoverage`;
}

function getCoverageUrl(run) {
  return `https://public-api.meteofrance.fr/public/arome/1.0/wcs/METADATA`;
}

// ========================================================
// VARIABLES AROME
// ========================================================

const AROME_VARIABLES = {
  rain: {
    aliases: ["rain", "precipitation"],
    candidates: [
      {
        startsWith: "TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__",
        endsWith: "_PT1H",
      },
      {
        startsWith: "TOTAL_PRECIPITATION__GROUND_OR_WATER_SURFACE__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "max",
    responseKey: "max_mm",
    unit: "mm",
    defaultHeight: null,
  },

  precip_rate: {
    aliases: ["precip_rate"],
    candidates: [
      {
        startsWith: "TOTAL_PRECIPITATION_RATE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "max",
    responseKey: "max_mmh",
    unit: "mm/h",
    defaultHeight: 2,
  },

  gust: {
    aliases: ["gust", "wind_gust", "wind_gusts"],
    candidates: [
      {
        startsWith: "WIND_SPEED_GUST_MAX__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
      {
        startsWith: "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "max",
    responseKey: "max_ms",
    unit: "m/s",
    defaultHeight: 10,
    postProcess: (v) => ({
      max_ms: v,
      max_kmh: Number.isFinite(v) ? v * 3.6 : null,
    }),
  },

  wind_speed: {
    aliases: ["wind_speed", "wind"],
    candidates: [
      {
        startsWith: "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_ms",
    unit: "m/s",
    defaultHeight: 10,
    postProcess: (v) => ({
      value_ms: v,
      value_kmh: Number.isFinite(v) ? v * 3.6 : null,
    }),
  },

  wind_dir: {
    aliases: ["wind_dir", "wind_direction", "direction"],
    candidates: [
      {
        startsWith: "WIND__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
      {
        startsWith: "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_deg",
    unit: "deg",
    defaultHeight: 10,
  },

  rh: {
    aliases: ["rh", "humidity", "relative_humidity"],
    candidates: [
      {
        startsWith: "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_percent",
    unit: "%",
    defaultHeight: 2,
  },

  temp: {
    aliases: ["temp", "temperature"],
    candidates: [
      {
        startsWith: "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_c",
    unit: "°C",
    defaultHeight: 2,
    convert: "k_to_c",
  },

  temp_min: {
    aliases: ["temp_min", "minimum_temperature"],
    candidates: [
      {
        startsWith: "MINIMUM_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "min",
    responseKey: "value_c",
    unit: "°C",
    defaultHeight: 2,
    convert: "k_to_c",
  },

  dewpoint: {
    aliases: ["dewpoint", "dew_point"],
    candidates: [
      {
        startsWith: "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_c",
    unit: "°C",
    defaultHeight: 2,
    convert: "k_to_c",
  },

  pressure: {
    aliases: ["pressure", "pressure_msl"],
    candidates: [
      {
        startsWith: "PRESSURE__MEAN_SEA_LEVEL__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_hpa",
    unit: "hPa",
    defaultHeight: null,
    convert: "pa_to_hpa",
  },

  soil_temp: {
    aliases: ["soil_temp", "ground_temperature", "surface_temperature"],
    candidates: [
      {
        startsWith: "TEMPERATURE__GROUND_OR_WATER_SURFACE__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "mean",
    responseKey: "value_c",
    unit: "°C",
    defaultHeight: null,
    convert: "k_to_c",
  },

  lightning: {
    aliases: ["lightning", "lightning_density"],
    candidates: [
      {
        startsWith: "LIGHTNING_STRIKE_DENSITY__GROUND_OR_WATER_SURFACE__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "max",
    responseKey: "value",
    unit: "strikes/km²",
    defaultHeight: null,
  },

  cape: {
    aliases: ["cape"],
    candidates: [
      {
        startsWith: "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE__",
        endsWith: "_PT1H",
      },
    ],
    reducer: "max",
    responseKey: "value_jkg",
    unit: "J/kg",
    defaultHeight: null,
  },
};

// ========================================================
// HELPERS GÉNÉRAUX
// ========================================================

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSlug(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizeVariableName(raw) {
  const q = String(raw || "").trim().toLowerCase();
  if (!q) return null;

  for (const [key, cfg] of Object.entries(AROME_VARIABLES)) {
    if (key === q) return key;
    if ((cfg.aliases || []).includes(q)) return key;
  }
  return null;
}

function kmToLatDeg(km) {
  return km / 111.32;
}

function kmToLonDeg(km, latDeg) {
  const c = Math.cos((latDeg * Math.PI) / 180);
  const safe = Math.max(Math.abs(c), 0.05);
  return km / (111.32 * safe);
}

function bboxFromRadiusKm(lat, lon, radiusKm) {
  const dLat = kmToLatDeg(radiusKm);
  const dLon = kmToLonDeg(radiusKm, lat);
  return {
    longMin: lon - dLon,
    longMax: lon + dLon,
    latMin: lat - dLat,
    latMax: lat + dLat,
  };
}

// ========================================================
// LIEUX DEPUIS LE WORKER PREMIUM
// ========================================================

async function loadPlaces() {
  const now = Date.now();

  if (placesCache.data && now - placesCache.ts < PLACES_TTL_MS) {
    return placesCache.data;
  }

  const r = await fetch(PLACES_SOURCE_URL, {
    headers: { accept: "application/json" },
  });

  if (!r.ok) {
    throw new Error(`places_fetch_failed_${r.status}`);
  }

  const json = await r.json();

  const rawPlaces =
    json.places ||
    json.locations ||
    json.reunion_places ||
    json.data ||
    [];

  if (!Array.isArray(rawPlaces)) {
    throw new Error("places_invalid_format");
  }

  const places = rawPlaces
    .map((p) => {
      const lat =
        Number(p.lat) ||
        Number(p.latitude) ||
        Number(p.latitude_deg) ||
        Number(p?.coords?.lat) ||
        Number(p?.geometry?.lat) ||
        Number(p?.location?.lat);

      const lon =
        Number(p.lon) ||
        Number(p.lng) ||
        Number(p.long) ||
        Number(p.longitude) ||
        Number(p.longitude_deg) ||
        Number(p?.coords?.lon) ||
        Number(p?.coords?.lng) ||
        Number(p?.geometry?.lon) ||
        Number(p?.geometry?.lng) ||
        Number(p?.location?.lon) ||
        Number(p?.location?.lng);

      return {
        slug: p.slug,
        label: p.label || p.name || p.slug,
        lat,
        lon,
        raw: p,
      };
    })
    .filter(
      (p) =>
        p.slug &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon)
    );

  if (!places.length) {
    console.log("DEBUG places payload:", JSON.stringify(rawPlaces.slice(0, 3), null, 2));
    throw new Error("places_empty_or_no_coordinates");
  }

  placesCache = {
    ts: now,
    data: places,
  };

  return places;
}

async function resolvePlaceFromCity(city) {
  const places = await loadPlaces();
  const slug = normalizeSlug(city);

  const place = places.find((p) => normalizeSlug(p.slug) === slug) || null;
  if (!place) return null;

  return {
    slug: place.slug,
    label: place.label,
    lat: place.lat,
    lon: place.lon,
  };
}

async function getPoint(req) {
  const city = String(req.query.city || req.query.slug || "").trim();

  if (city) {
    const place = await resolvePlaceFromCity(city);
    if (!place) {
      throw new Error(`unknown_city_${city}`);
    }
    return {
      source: "city",
      city: place.slug,
      label: place.label,
      lat: place.lat,
      lon: place.lon,
    };
  }

  const lat = parseNum(req.query.lat, FALLBACK_POINT.lat);
  const lon = parseNum(req.query.lon, FALLBACK_POINT.lon);

  return {
    source: "latlon",
    city: null,
    label: null,
    lat,
    lon,
  };
}

// ========================================================
// WCS HELPERS
// ========================================================

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      apikey: process.env.AROME_APIKEY || "",
      accept: "application/xml,text/xml,*/*",
    },
  });

  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

function extractCoverageIds(xml) {
  const ids = [];
  const re = /<wcs:CoverageId>([^<]+)<\/wcs:CoverageId>/g;
  let m;
  while ((m = re.exec(xml))) {
    ids.push(m[1]);
  }
  return ids;
}

function latestRunStamp(ids) {
  const stamps = [];
  const re = /(\d{8}T\d{2})/g;

  for (const id of ids) {
    let m;
    while ((m = re.exec(id))) {
      stamps.push(m[1]);
    }
  }

  if (!stamps.length) return null;
  stamps.sort();
  return stamps[stamps.length - 1];
}

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

function pickCoverageId(ids, stamp, cfg) {
  for (const c of cfg.candidates || []) {
    const found = ids.find((x) => {
      if (!x.startsWith(c.startsWith)) return false;
      if (c.endsWith && !x.endsWith(c.endsWith)) return false;
      if (stamp && !x.includes(stamp)) return false;
      return true;
    });
    if (found) return found;
  }
  return null;
}

function convertValue(v, mode) {
  if (!Number.isFinite(v)) return null;
  if (mode === "k_to_c") return v - 273.15;
  if (mode === "pa_to_hpa") return v / 100.0;
  return v;
}

async function resolve(run, variable) {
  const varKey = normalizeVariableName(variable);
  if (!varKey) {
    return { ok: false, status: 400, error: "unknown_variable", variable };
  }

  const cfg = AROME_VARIABLES[varKey];
  const cap = await fetchText(capabilitiesUrl(run));

  if (!cap.ok) {
    return {
      ok: false,
      status: cap.status,
      error: "capabilities_failed",
      detail: cap.text.slice(0, 300),
    };
  }

  const ids = extractCoverageIds(cap.text);
  const stamp = latestRunStamp(ids);

  if (!stamp) {
    return { ok: false, status: 500, error: "no_run_stamp_found" };
  }

  const coverageId = pickCoverageId(ids, stamp, cfg);

  if (!coverageId) {
    return {
      ok: false,
      status: 500,
      error: "coverage_not_found",
      variable: varKey,
      stamp,
      debug_candidates: cfg.candidates || [],
    };
  }

  const du = new URL(describeUrl(run));
  du.searchParams.set("coverageId", coverageId);

  const desc = await fetchText(du.toString());
  if (!desc.ok) {
    return {
      ok: false,
      status: desc.status,
      error: "describe_failed",
      variable: varKey,
      coverageId,
      detail: desc.text.slice(0, 400),
    };
  }

  const axisLabels = parseAxisLabels(desc.text);
  const timeCoeffs = parseCoefficientsForAxis(desc.text, "time");
  const timeSeconds = firstNumber(timeCoeffs, 3600);

  let heightVal = null;
  if (axisLabels.includes("height")) {
    const heightCoeffs = parseCoefficientsForAxis(desc.text, "height");
    const availableHeights = (heightCoeffs || [])
      .map(Number)
      .filter(Number.isFinite);

    if (
      Number.isFinite(cfg.defaultHeight) &&
      availableHeights.includes(cfg.defaultHeight)
    ) {
      heightVal = cfg.defaultHeight;
    } else if (availableHeights.length > 0) {
      heightVal = availableHeights[0];
    } else if (Number.isFinite(cfg.defaultHeight)) {
      heightVal = cfg.defaultHeight;
    }
  }

  return {
    ok: true,
    variable: varKey,
    stamp,
    coverageId,
    timeSeconds,
    heightVal,
    axisLabels,
  };
}

async function getCoverageTiff({ run, coverageId, timeSeconds, heightVal, bbox }) {
  const u = new URL(getCoverageUrl(run));
  u.searchParams.set("service", "WCS");
  u.searchParams.set("version", "2.0.1");
  u.searchParams.set("request", "GetCoverage");
  u.searchParams.set("coverageid", coverageId);
  u.searchParams.set("format", "image/tiff");

  u.searchParams.append("subset", `long(${bbox.longMin},${bbox.longMax})`);
  u.searchParams.append("subset", `lat(${bbox.latMin},${bbox.latMax})`);
  u.searchParams.append("subset", `time(${timeSeconds})`);

  if (heightVal != null) {
    u.searchParams.append("subset", `height(${heightVal})`);
  }

  const r = await fetch(u.toString(), {
    headers: {
      apikey: process.env.AROME_APIKEY || "",
      accept: "*/*",
    },
  });

  const buf = await r.arrayBuffer();
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return { status: r.status, ct, buf };
}

async function sampleGeoTiff(arrayBuffer, reducer = "max") {
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();

  const samples = 5;
  const values = [];

  for (let yi = 0; yi < samples; yi++) {
    for (let xi = 0; xi < samples; xi++) {
      const x = Math.round((xi / (samples - 1)) * (width - 1));
      const y = Math.round((yi / (samples - 1)) * (height - 1));
      const ras = await image.readRasters({ window: [x, y, x + 1, y + 1] });
      const v = ras?.[0]?.[0];
      if (Number.isFinite(v)) values.push(v);
    }
  }

  if (!values.length) return null;
  if (reducer === "max") return Math.max(...values);
  if (reducer === "min") return Math.min(...values);
  if (reducer === "mean") {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  return null;
}

function buildValuePayload(variable, rawValue) {
  const varKey = normalizeVariableName(variable);
  const cfg = AROME_VARIABLES[varKey];
  const converted = convertValue(rawValue, cfg.convert);

  if (typeof cfg.postProcess === "function") {
    return cfg.postProcess(converted);
  }

  return { [cfg.responseKey]: converted };
}

function listMatchingCoverageIds(ids, variable) {
  const varKey = normalizeVariableName(variable);
  if (!varKey) return [];
  const cfg = AROME_VARIABLES[varKey];

  const out = [];
  for (const id of ids) {
    for (const c of cfg.candidates || []) {
      const okStart = id.startsWith(c.startsWith);
      const okEnd = c.endsWith ? id.endsWith(c.endsWith) : true;
      if (okStart && okEnd) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

// ========================================================
// CORE AROME
// ========================================================

async function getVariableValue({ variable, run, lat, lon, radiusKm, timeSeconds = null }) {
  const varKey = normalizeVariableName(variable);
  const cfg = AROME_VARIABLES[varKey];

  if (!cfg) throw new Error("unknown_variable");

  const info = await resolve(run, varKey);
  if (!info.ok) return info;

  const bbox = bboxFromRadiusKm(lat, lon, radiusKm);
  const tSec = Number.isFinite(timeSeconds) ? timeSeconds : info.timeSeconds;

  const cov = await getCoverageTiff({
    run,
    coverageId: info.coverageId,
    timeSeconds: tSec,
    heightVal: info.heightVal,
    bbox,
  });

  if (cov.status < 200 || cov.status >= 300) {
    return { ok: false, status: cov.status, error: "download_failed" };
  }

  const rawValue = await sampleGeoTiff(cov.buf, cfg.reducer);
  const payload = buildValuePayload(varKey, rawValue);

  return {
    ok: true,
    variable: varKey,
    run,
    coverageId: info.coverageId,
    timeSeconds: tSec,
    height: info.heightVal,
    lat,
    lon,
    radius_km: radiusKm,
    unit: cfg.unit,
    ...payload,
  };
}

async function getVariableSeries({ variable, run, lat, lon, radiusKm, hours }) {
  const varKey = normalizeVariableName(variable);
  const cfg = AROME_VARIABLES[varKey];

  if (!cfg) {
    return { ok: false, status: 400, error: "unknown_variable", variable };
  }

  const info = await resolve(run, varKey);
  if (!info.ok) return info;

  const step = Number(info.timeSeconds || 3600);
  const steps = Math.floor((hours * 3600) / step);
  const bbox = bboxFromRadiusKm(lat, lon, radiusKm);

  const series = [];
  for (let i = 1; i <= steps; i++) {
    const tSec = i * step;

    const cov = await getCoverageTiff({
      run,
      coverageId: info.coverageId,
      timeSeconds: tSec,
      heightVal: info.heightVal,
      bbox,
    });

    if (cov.status < 200 || cov.status >= 300) {
      series.push({
        t_seconds: tSec,
        ok: false,
        error: `download_${cov.status}`,
      });
      continue;
    }

    const rawValue = await sampleGeoTiff(cov.buf, cfg.reducer);
    const payload = buildValuePayload(varKey, rawValue);

    series.push({
      t_seconds: tSec,
      ok: true,
      ...payload,
    });
  }

  return {
    ok: true,
    variable: varKey,
    run,
    coverageId: info.coverageId,
    height: info.heightVal,
    step_seconds: step,
    hours,
    lat,
    lon,
    radius_km: radiusKm,
    unit: cfg.unit,
    series,
  };
}

// ========================================================
// ROUTES
// ========================================================

app.use((req, res, next) => {
  cors(res);
  next();
});

app.options("*", (req, res) => {
  res.status(204).end();
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "CycloneOI AROME API",
    status: "running",
    places_source: PLACES_SOURCE_URL,
    supported_variables: Object.keys(AROME_VARIABLES),
    endpoints: [
      "/v1/arome/places",
      "/v1/arome/debug/capabilities?run=001",
      "/v1/arome/debug/resolve?run=001&variable=rain",
      "/v1/arome/debug/match?run=001&variable=temp",
      "/v1/arome/rain/value?city=saint-denis&run=001&radius_km=5",
      "/v1/arome/gust/value?city=saint-denis&run=001&radius_km=5",
      "/v1/arome/temp/value?city=saint-denis&run=001&radius_km=5",
      "/v1/arome/rh/value?city=saint-denis&run=001&radius_km=5",
      "/v1/arome/pressure/value?city=saint-denis&run=001&radius_km=5",
      "/v1/arome/rain/series?city=saint-denis&run=001&hours=48&radius_km=5",
      "/v1/arome/gust/series?city=saint-denis&run=001&hours=48&radius_km=5",
      "/v1/arome/point/series?vars=rain,gust,temp,rh,dewpoint,pressure&city=saint-denis&run=001&hours=48&radius_km=5",
    ],
  });
});

app.get("/v1/arome/places", async (req, res) => {
  try {
    const places = await loadPlaces();
    res.json({
      ok: true,
      count: places.length,
      places,
      cached_at: placesCache.ts || null,
      source: PLACES_SOURCE_URL,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "places_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/debug/capabilities", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const cap = await fetchText(capabilitiesUrl(run));

  if (!cap.ok) {
    return res.status(cap.status).json({
      ok: false,
      error: "capabilities_failed",
      detail: cap.text.slice(0, 500),
    });
  }

  const ids = extractCoverageIds(cap.text);

  return res.json({
    ok: true,
    run,
    count: ids.length,
    latest_stamp: latestRunStamp(ids),
    ids,
  });
});

app.get("/v1/arome/debug/match", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const variable = String(req.query.variable || "rain");

  const cap = await fetchText(capabilitiesUrl(run));
  if (!cap.ok) {
    return res.status(cap.status).json({
      ok: false,
      error: "capabilities_failed",
      detail: cap.text.slice(0, 500),
    });
  }

  const ids = extractCoverageIds(cap.text);
  const matches = listMatchingCoverageIds(ids, variable);

  res.json({
    ok: true,
    run,
    variable,
    normalized_variable: normalizeVariableName(variable),
    matches_count: matches.length,
    matches,
  });
});

app.get("/v1/arome/debug/resolve", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const variable = String(req.query.variable || req.query.type || "rain");
  const out = await resolve(run, variable);
  res.status(out.ok ? 200 : out.status || 500).json(out);
});

// Téléchargement brut TIFF pour une variable
app.get("/v1/arome/:variable/download", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const variable = String(req.params.variable || "");
    const varKey = normalizeVariableName(variable);

    if (!varKey) {
      return res.status(400).json({ ok: false, error: "unknown_variable" });
    }

    const info = await resolve(run, varKey);
    if (!info.ok) return res.status(info.status || 500).json(info);

    const point = await getPoint(req);
    const radiusKm = clamp(
      parseNum(req.query.radius_km, DEFAULT_RADIUS_KM),
      1,
      MAX_RADIUS_KM
    );

    const bbox = bboxFromRadiusKm(point.lat, point.lon, radiusKm);

    const out = await getCoverageTiff({
      run,
      coverageId: info.coverageId,
      timeSeconds: info.timeSeconds,
      heightVal: info.heightVal,
      bbox,
    });

    res.status(out.status);
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Content-Type", out.ct);
    res.send(Buffer.from(out.buf));
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "download_failed",
      message: String(e?.message || e),
    });
  }
});

// Valeur ponctuelle d'une variable
app.get("/v1/arome/:variable/value", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const variable = String(req.params.variable || "");
    const radiusKm = clamp(
      parseNum(req.query.radius_km, DEFAULT_RADIUS_KM),
      1,
      MAX_RADIUS_KM
    );

    const point = await getPoint(req);

    const out = await getVariableValue({
      variable,
      run,
      lat: point.lat,
      lon: point.lon,
      radiusKm,
    });

    if (!out.ok) {
      return res.status(out.status || 500).json(out);
    }

    res.json({
      ...out,
      point_source: point.source,
      city: point.city,
      label: point.label,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "value_failed",
      message: String(e?.message || e),
    });
  }
});

// Série d'une seule variable
app.get("/v1/arome/:variable/series", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const variable = String(req.params.variable || "");
    const hours = clamp(
      parseInt(String(req.query.hours || DEFAULT_HOURS), 10) || DEFAULT_HOURS,
      1,
      MAX_HOURS
    );
    const radiusKm = clamp(
      parseNum(req.query.radius_km, DEFAULT_RADIUS_KM),
      1,
      MAX_RADIUS_KM
    );

    const point = await getPoint(req);

    const out = await getVariableSeries({
      variable,
      run,
      lat: point.lat,
      lon: point.lon,
      radiusKm,
      hours,
    });

    if (!out.ok) {
      return res.status(out.status || 500).json(out);
    }

    res.json({
      ...out,
      point_source: point.source,
      city: point.city,
      label: point.label,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "series_failed",
      message: String(e?.message || e),
    });
  }
});

// Série multi-variables
app.get("/v1/arome/point/series", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const hours = clamp(
      parseInt(String(req.query.hours || DEFAULT_HOURS), 10) || DEFAULT_HOURS,
      1,
      MAX_HOURS
    );
    const radiusKm = clamp(
      parseNum(req.query.radius_km, DEFAULT_RADIUS_KM),
      1,
      MAX_RADIUS_KM
    );

    const point = await getPoint(req);

    const vars = String(req.query.vars || "")
      .split(",")
      .map((v) => normalizeVariableName(v))
      .filter(Boolean);

    if (!vars.length) {
      return res.status(400).json({
        ok: false,
        error: "vars_required",
        message: "Ex: ?vars=rain,gust,temp,rh,dewpoint,pressure",
      });
    }

    const hourly = {};
    const meta = {};

    for (const v of vars) {
      const out = await getVariableSeries({
        variable: v,
        run,
        lat: point.lat,
        lon: point.lon,
        radiusKm,
        hours,
      });

      if (!out.ok) {
        hourly[v] = {
          ok: false,
          error: out.error || "series_failed",
          detail: out.detail || null,
        };
      } else {
        hourly[v] = out.series;
        meta[v] = {
          coverageId: out.coverageId,
          height: out.height,
          step_seconds: out.step_seconds,
          unit: out.unit,
        };
      }
    }

    res.json({
      ok: true,
      run,
      hours,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      radius_km: radiusKm,
      vars,
      meta,
      hourly,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "point_series_failed",
      message: String(e?.message || e),
    });
  }
});

// Compat legacy
app.get("/v1/arome/rain/latest", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const out = await resolve(run, "rain");
  res.status(out.ok ? 200 : out.status || 500).json(out);
});

app.get("/v1/arome/gust/latest", async (req, res) => {
  const run = String(req.query.run || RUN_DEFAULT);
  const out = await resolve(run, "gust");
  res.status(out.ok ? 200 : out.status || 500).json(out);
});

app.listen(PORT, () => {
  console.log("CycloneOI AROME API listening on", PORT);
});
