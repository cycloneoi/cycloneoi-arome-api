import express from "express";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================================
// CONFIG
// ========================================================

const MF_BASE =
  process.env.MF_BASE ||
  "https://public-api.meteofrance.fr/previnum/DPPaquetAROME-OM/v1";

const MF_MODEL = "AROME-OM-INDIEN";
const MF_PRODUCT_ID = "productOMOI";

const MF_BEARER_TOKEN = process.env.MF_BEARER_TOKEN || "";
const MF_APIKEY = process.env.AROME_APIKEY || process.env.MF_APIKEY || "";

const PLACES_SOURCE_URL =
  "https://cycloneoi-premium.patrick-rabeson.workers.dev/v1/locations?resolve=1";
const PLACES_TTL_MS = 6 * 60 * 60 * 1000;

let placesCache = {
  ts: 0,
  data: null,
};

// ========================================================
// VARIABLES CONFIRMÉES
// ========================================================

const VARIABLE_SPECS = {
  pressure_msl: {
    aliases: ["prmsl", "pressure_msl", "msl_pressure", "pressure"],
    label: "Pression au niveau de la mer",
    package: "SP1",
    shortName: "prmsl",
    unit: "hPa",
    responseKey: "value_hpa",
    convert: (v) => (Number.isFinite(v) ? v / 100 : null),
  },

  wind_dir_10m: {
    aliases: ["wind_dir_10m", "wind_direction_10m", "10wdir", "wind_dir"],
    label: "Direction du vent 10 m",
    package: "SP1",
    shortName: "10wdir",
    unit: "deg",
    responseKey: "value_deg",
  },

  wind_u_10m: {
    aliases: ["wind_u_10m", "u10", "10u"],
    label: "Composante U vent 10 m",
    package: "SP1",
    shortName: "10u",
    unit: "m/s",
    responseKey: "value_ms",
  },

  wind_gust_10m: {
    aliases: ["wind_gust_10m", "gust", "gust_10m", "10fg"],
    label: "Rafales 10 m",
    package: "SP1",
    shortName: "10fg",
    unit: "m/s",
    responseKey: "value_ms",
    postProcess: (v) => ({
      value_ms: v,
      value_kmh: Number.isFinite(v) ? v * 3.6 : null,
    }),
  },

  rh_2m: {
    aliases: ["rh_2m", "humidity_2m", "relative_humidity_2m", "2r", "rh"],
    label: "Humidité relative 2 m",
    package: "SP1",
    shortName: "2r",
    unit: "%",
    responseKey: "value_percent",
  },

  precip_total: {
    aliases: ["precip_total", "tp", "rain_total", "precipitation_total"],
    label: "Précipitations totales",
    package: "SP1",
    shortName: "tp",
    unit: "mm (approx.)",
    responseKey: "value_mm",
  },

  precip_rate: {
    aliases: ["precip_rate", "sprate", "rain_rate", "precipitation_rate"],
    label: "Taux de précipitation",
    package: "SP1",
    shortName: "sprate",
    unit: "mm/h (approx.)",
    responseKey: "value_mmh",
    convert: (v) => (Number.isFinite(v) ? v * 3600 : null),
  },

  solar_downward: {
    aliases: ["solar_downward", "ssrd"],
    label: "Rayonnement solaire descendant",
    package: "SP1",
    shortName: "ssrd",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  temp_2m: {
    aliases: ["temp_2m", "temperature_2m", "2t", "temp"],
    label: "Température 2 m",
    package: "SP2",
    shortName: "2t",
    unit: "°C",
    responseKey: "value_c",
    convert: (v) => (Number.isFinite(v) ? v - 273.15 : null),
  },

  dewpoint_2m: {
    aliases: ["dewpoint_2m", "dewpoint", "td_2m", "2d"],
    label: "Point de rosée 2 m",
    package: "SP2",
    shortName: "2d",
    unit: "°C",
    responseKey: "value_c",
    convert: (v) => (Number.isFinite(v) ? v - 273.15 : null),
  },

  pressure_surface: {
    aliases: ["pressure_surface", "surface_pressure", "sp"],
    label: "Pression au sol",
    package: "SP2",
    shortName: "sp",
    unit: "hPa",
    responseKey: "value_hpa",
    convert: (v) => (Number.isFinite(v) ? v / 100 : null),
  },

  cloud_low: {
    aliases: ["cloud_low", "low_cloud", "lcc"],
    label: "Nébulosité basse",
    package: "SP2",
    shortName: "lcc",
    unit: "%",
    responseKey: "value_percent",
  },

  cloud_mid: {
    aliases: ["cloud_mid", "mid_cloud", "mcc"],
    label: "Nébulosité moyenne",
    package: "SP2",
    shortName: "mcc",
    unit: "%",
    responseKey: "value_percent",
  },

  cloud_high: {
    aliases: ["cloud_high", "high_cloud", "hcc"],
    label: "Nébulosité haute",
    package: "SP2",
    shortName: "hcc",
    unit: "%",
    responseKey: "value_percent",
  },

  cape: {
    aliases: ["cape", "cape_ins", "CAPE_INS"],
    label: "CAPE instantané",
    package: "SP2",
    shortName: "CAPE_INS",
    unit: "J/kg",
    responseKey: "value_jkg",
  },

  boundary_layer_height: {
    aliases: ["boundary_layer_height", "blh", "mixed_layer_height"],
    label: "Hauteur de couche limite",
    package: "SP2",
    shortName: "blh",
    unit: "m",
    responseKey: "value_m",
  },

  surface_latent_heat_flux: {
    aliases: ["surface_latent_heat_flux", "slhf"],
    label: "Flux latent de surface",
    package: "SP3",
    shortName: "slhf",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_sensible_heat_flux: {
    aliases: ["surface_sensible_heat_flux", "sshf"],
    label: "Flux sensible de surface",
    package: "SP3",
    shortName: "sshf",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_net_solar_radiation: {
    aliases: ["surface_net_solar_radiation", "ssr"],
    label: "Rayonnement solaire net de surface",
    package: "SP3",
    shortName: "ssr",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_net_solar_radiation_clear_sky: {
    aliases: ["surface_net_solar_radiation_clear_sky", "ssrc"],
    label: "Rayonnement solaire net de surface ciel clair",
    package: "SP3",
    shortName: "ssrc",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_downward_thermal_radiation: {
    aliases: ["surface_downward_thermal_radiation", "strd"],
    label: "Rayonnement thermique descendant de surface",
    package: "SP3",
    shortName: "strd",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_net_thermal_radiation: {
    aliases: ["surface_net_thermal_radiation", "str"],
    label: "Rayonnement thermique net de surface",
    package: "SP3",
    shortName: "str",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  surface_net_thermal_radiation_clear_sky: {
    aliases: ["surface_net_thermal_radiation_clear_sky", "strc"],
    label: "Rayonnement thermique net de surface ciel clair",
    package: "SP3",
    shortName: "strc",
    unit: "J/m²",
    responseKey: "value_jm2",
  },

  eastward_surface_stress: {
    aliases: ["eastward_surface_stress", "ewss"],
    label: "Contrainte de surface est-ouest",
    package: "SP3",
    shortName: "ewss",
    unit: "N/m²",
    responseKey: "value",
  },

  northward_surface_stress: {
    aliases: ["northward_surface_stress", "nsss"],
    label: "Contrainte de surface nord-sud",
    package: "SP3",
    shortName: "nsss",
    unit: "N/m²",
    responseKey: "value",
  },
};

const PENDING_VARIABLES = {
  wind_speed_10m: "Pas confirmé dans l’inventaire actuel. 10v non identifié clairement.",
  soil_temp: "Non confirmé par shortName dans SP2 actuel.",
  q_2m: "Décrit dans le package SP2 mais shortName non confirmé dans l’inventaire partagé.",
  cloud_convective: "Décrit dans SP2 mais shortName non confirmé dans l’inventaire partagé.",
  temp_min_2m: "Décrit dans SP2 mais shortName non confirmé dans l’inventaire partagé.",
  temp_max_2m: "Décrit dans SP2 mais shortName non confirmé dans l’inventaire partagé.",
  uv_index: "Non présent dans les packages confirmés.",
  lightning_density: "Non présent dans les packages confirmés.",
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

  for (const [key, cfg] of Object.entries(VARIABLE_SPECS)) {
    if (key === q) return key;
    if ((cfg.aliases || []).map((x) => String(x).toLowerCase()).includes(q)) {
      return key;
    }
  }
  return null;
}

function isoUtcNoMs(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildMfHeaders(accept = "application/json") {
  const headers = { accept };
  if (MF_BEARER_TOKEN) headers.Authorization = `Bearer ${MF_BEARER_TOKEN}`;
  if (MF_APIKEY) headers.apikey = MF_APIKEY;
  return headers;
}

function toResponsePayload(cfg, rawValue) {
  const converted =
    typeof cfg.convert === "function" ? cfg.convert(rawValue) : rawValue;

  if (typeof cfg.postProcess === "function") {
    return cfg.postProcess(converted);
  }

  return { [cfg.responseKey]: converted };
}

function heatIndexCelsius(tempC, rh) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) return null;
  const tempF = tempC * 9 / 5 + 32;

  if (tempF < 80 || rh < 40) return tempC;

  const HI =
    -42.379 +
    2.04901523 * tempF +
    10.14333127 * rh -
    0.22475541 * tempF * rh -
    0.00683783 * tempF * tempF -
    0.05481717 * rh * rh +
    0.00122874 * tempF * tempF * rh +
    0.00085282 * tempF * rh * rh -
    0.00000199 * tempF * tempF * rh * rh;

  return (HI - 32) * 5 / 9;
}

function windChillCelsius(tempC, windKmh) {
  if (!Number.isFinite(tempC) || !Number.isFinite(windKmh)) return null;
  if (tempC > 10 || windKmh <= 4.8) return tempC;

  return (
    13.12 +
    0.6215 * tempC -
    11.37 * Math.pow(windKmh, 0.16) +
    0.3965 * tempC * Math.pow(windKmh, 0.16)
  );
}

function computeApparentTemperature(tempC, rh, windMsApprox = null) {
  if (!Number.isFinite(tempC)) return null;

  const windKmh = Number.isFinite(windMsApprox) ? windMsApprox * 3.6 : null;

  if (Number.isFinite(windKmh) && tempC <= 10) {
    return windChillCelsius(tempC, windKmh);
  }

  if (Number.isFinite(rh)) {
    return heatIndexCelsius(tempC, rh);
  }

  return tempC;
}

function thunderstormRiskLevel(score) {
  if (!Number.isFinite(score)) return "indetermine";
  if (score < 20) return "faible";
  if (score < 40) return "modere";
  if (score < 65) return "eleve";
  return "tres-eleve";
}

function computeThunderstormRisk(values) {
  let score = 0;

  if (Number.isFinite(values.cape)) {
    if (values.cape >= 1500) score += 35;
    else if (values.cape >= 800) score += 25;
    else if (values.cape >= 300) score += 15;
    else if (values.cape >= 100) score += 8;
  }

  if (Number.isFinite(values.dewpoint_2m)) {
    if (values.dewpoint_2m >= 22) score += 18;
    else if (values.dewpoint_2m >= 18) score += 12;
    else if (values.dewpoint_2m >= 15) score += 7;
  }

  if (Number.isFinite(values.rh_2m)) {
    if (values.rh_2m >= 85) score += 14;
    else if (values.rh_2m >= 75) score += 10;
    else if (values.rh_2m >= 65) score += 5;
  }

  if (Number.isFinite(values.precip_rate)) {
    if (values.precip_rate >= 10) score += 15;
    else if (values.precip_rate >= 4) score += 8;
    else if (values.precip_rate > 0) score += 3;
  }

  if (Number.isFinite(values.wind_gust_10m)) {
    if (values.wind_gust_10m >= 20) score += 10;
    else if (values.wind_gust_10m >= 14) score += 6;
    else if (values.wind_gust_10m >= 8) score += 3;
  }

  const cloudCombo = [
    values.cloud_low,
    values.cloud_mid,
    values.cloud_high,
  ].filter(Number.isFinite);

  if (cloudCombo.length) {
    const avgCloud =
      cloudCombo.reduce((a, b) => a + b, 0) / cloudCombo.length;
    if (avgCloud >= 85) score += 10;
    else if (avgCloud >= 60) score += 6;
    else if (avgCloud >= 35) score += 3;
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    thunderstorm_risk_score: score,
    thunderstorm_risk_level: thunderstormRiskLevel(score),
  };
}

function groupByPackage(variableKeys) {
  const out = {};
  for (const key of variableKeys) {
    const cfg = VARIABLE_SPECS[key];
    if (!cfg) continue;
    if (!out[cfg.package]) out[cfg.package] = [];
    out[cfg.package].push(key);
  }
  return out;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ========================================================
// HELPERS API MFR
// ========================================================

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: buildMfHeaders("application/json,text/json,*/*"),
  });
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`upstream_${r.status}: ${text.slice(0, 500)}`);
  }

  const parsed = safeJsonParse(text);
  if (!parsed) {
    throw new Error(`json_parse_failed: ${text.slice(0, 500)}`);
  }

  return parsed;
}

async function fetchBuffer(url) {
  const r = await fetch(url, { headers: buildMfHeaders("*/*") });
  const buf = await r.arrayBuffer();
  const ct = r.headers.get("content-type") || "application/octet-stream";

  if (!r.ok) {
    const text = new TextDecoder().decode(buf).slice(0, 500);
    throw new Error(`upstream_${r.status}: ${text}`);
  }

  return { buf, ct };
}

async function downloadProductToTempFile(url) {
  const r = await fetch(url, { headers: buildMfHeaders("*/*") });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`download_failed_${r.status}: ${text.slice(0, 500)}`);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  const filePath = path.join(
    os.tmpdir(),
    `arome-${Date.now()}-${Math.random().toString(36).slice(2)}.grib2`
  );

  await fs.writeFile(filePath, buf);
  return filePath;
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

async function gribLsVersion() {
  const { stdout, stderr } = await execFileAsync("grib_ls", ["-V"], {
    maxBuffer: 2 * 1024 * 1024,
  });

  return { stdout, stderr };
}

async function gribLsInventory(filePath) {
  const { stdout, stderr } = await execFileAsync("grib_ls", [filePath], {
    maxBuffer: 20 * 1024 * 1024,
  });

  return { stdout, stderr };
}

async function gribGetData(filePath, shortName) {
  const { stdout, stderr } = await execFileAsync(
    "grib_get_data",
    ["-w", `shortName=${shortName}`, filePath],
    { maxBuffer: 100 * 1024 * 1024 }
  );

  return { stdout, stderr };
}

function parseGribGetData(stdout) {
  const rows = [];
  const lines = String(stdout || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Latitude/i.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    const value = Number(parts[2]);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(value)) {
      continue;
    }

    if (Math.abs(value) > 1e19) continue;

    rows.push({ lat, lon, value });
  }

  return rows;
}

function nearestGridValue(rows, targetLat, targetLon) {
  if (!rows.length) return null;

  let best = null;

  for (const row of rows) {
    const d = kmBetween(targetLat, targetLon, row.lat, row.lon);
    if (!best || d < best.distance_km) {
      best = {
        lat: row.lat,
        lon: row.lon,
        value: row.value,
        distance_km: d,
      };
    }
  }

  return best;
}

// ========================================================
// LIEUX
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
      };
    })
    .filter((p) => p.slug && Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (!places.length) {
    throw new Error("places_empty_or_no_coordinates");
  }

  placesCache = { ts: now, data: places };
  return places;
}

async function resolvePlaceFromCity(city) {
  const places = await loadPlaces();
  const slug = normalizeSlug(city);
  return places.find((p) => normalizeSlug(p.slug) === slug) || null;
}

async function getPoint(req) {
  const city = String(req.query.city || req.query.slug || "").trim();

  if (city) {
    const place = await resolvePlaceFromCity(city);
    if (!place) throw new Error(`unknown_city_${city}`);
    return {
      source: "city",
      city: place.slug,
      label: place.label,
      lat: place.lat,
      lon: place.lon,
    };
  }

  const lat = parseNum(req.query.lat, null);
  const lon = parseNum(req.query.lon, null);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("missing_city_or_latlon");
  }

  return {
    source: "latlon",
    city: null,
    label: null,
    lat,
    lon,
  };
}

// ========================================================
// URLS MFR
// ========================================================

function modelUrl() {
  return `${MF_BASE}/models/${MF_MODEL}`;
}

function gridsUrl() {
  return `${MF_BASE}/models/${MF_MODEL}/grids`;
}

function packagesUrl(grid) {
  return `${MF_BASE}/models/${MF_MODEL}/grids/${encodeURIComponent(grid)}/packages`;
}

function packageUrl(grid, pkg, referencetime = null) {
  const u = new URL(
    `${MF_BASE}/models/${MF_MODEL}/grids/${encodeURIComponent(grid)}/packages/${encodeURIComponent(pkg)}`
  );
  if (referencetime) u.searchParams.set("referencetime", referencetime);
  return u.toString();
}

function productRestUrl(grid, pkg, referencetime, time, format = "grib2") {
  const u = new URL(
    `${MF_BASE}/models/${MF_MODEL}/grids/${encodeURIComponent(grid)}/packages/${encodeURIComponent(pkg)}/${MF_PRODUCT_ID}`
  );
  u.searchParams.set("referencetime", referencetime);
  u.searchParams.set("time", time);
  u.searchParams.set("format", format);
  return u.toString();
}

function productKvpUrl(grid, pkg, referencetime, time, format = "grib2") {
  const u = new URL(`${MF_BASE}/${MF_PRODUCT_ID}`);
  u.searchParams.set("grid", grid);
  u.searchParams.set("package", pkg);
  u.searchParams.set("referencetime", referencetime);
  u.searchParams.set("time", time);
  u.searchParams.set("format", format);
  return u.toString();
}

// ========================================================
// AUTO-SÉLECTION
// ========================================================

async function getGrids() {
  return await fetchJson(gridsUrl());
}

async function autoPickGrid() {
  const j = await getGrids();

  const links =
    (Array.isArray(j?.links) ? j.links : null) ||
    (Array.isArray(j?.data?.links) ? j.data.links : null) ||
    [];

  if (!links.length) {
    return { ok: false, error: "no_grids_found", raw: j };
  }

  const candidate = links.find((x) => {
    const href = String(x?.href || "");
    return /\/grids\/[^/]+$/.test(href) && !href.endsWith("/grids");
  });

  if (!candidate) {
    return { ok: false, error: "grid_link_not_found", raw: links };
  }

  const href = String(candidate?.href || "");
  const m = href.match(/\/grids\/([^/]+)$/);

  if (!m) {
    return { ok: false, error: "grid_parse_failed", raw: candidate };
  }

  return {
    ok: true,
    grid: decodeURIComponent(m[1]),
    raw: links,
  };
}

async function getPackages(grid) {
  return await fetchJson(packagesUrl(grid));
}

async function autoPickPackage(grid) {
  const j = await getPackages(grid);

  const links =
    (Array.isArray(j?.links) ? j.links : null) ||
    (Array.isArray(j?.data?.links) ? j.data.links : null) ||
    [];

  if (!links.length) {
    return { ok: false, error: "no_packages_found", raw: j };
  }

  const packages = links
    .map((x) => {
      const href = String(x?.href || "");
      const m = href.match(/\/packages\/([^/]+)$/);
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter(Boolean)
    .filter((x) => x !== "packages");

  if (!packages.length) {
    return { ok: false, error: "package_parse_failed", raw: links };
  }

  const sp1 = packages.find((x) => String(x).toUpperCase() === "SP1");

  return {
    ok: true,
    package: sp1 || packages[0],
    raw: links,
  };
}

async function getPackageDetails(grid, pkg, referencetime = null) {
  return await fetchJson(packageUrl(grid, pkg, referencetime));
}

function extractReferenceTimes(j) {
  const directArrays = [
    j?.referencetimes,
    j?.referenceTimes,
    j?.references,
    j?.runs,
    j?.data,
  ];

  for (const arr of directArrays) {
    if (Array.isArray(arr)) {
      const refs = arr
        .map((x) => x?.referencetime || x?.referenceTime || x?.value || x)
        .filter(Boolean);
      if (refs.length) return refs;
    }
  }

  const links =
    (Array.isArray(j?.links) ? j.links : null) ||
    (Array.isArray(j?.data?.links) ? j.data.links : null) ||
    [];

  const refs = links
    .map((x) => {
      const href = String(x?.href || "");
      try {
        const u = new URL(href);
        return u.searchParams.get("referencetime");
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return refs;
}

async function autoPickReferenceTime(grid, pkg) {
  const j = await getPackageDetails(grid, pkg);
  const refs = extractReferenceTimes(j);

  if (refs.length) {
    const sorted = refs.slice().sort();
    return { ok: true, referencetime: sorted[sorted.length - 1], raw: j };
  }

  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return { ok: true, referencetime: isoUtcNoMs(d), raw: j, fallback: true };
}

async function resolveAutoProduct(time = "001H", format = "grib2") {
  const requestedTime = String(time || "001H").trim();
  const requestedFormat = String(format || "grib2").trim();

  const g = await autoPickGrid();
  if (!g.ok) return g;

  const p = await autoPickPackage(String(g.grid));
  if (!p.ok) return p;

  const r = await autoPickReferenceTime(String(g.grid), String(p.package));
  if (!r.ok) return r;

  return {
    ok: true,
    model: MF_MODEL,
    grid: String(g.grid),
    package: String(p.package),
    referencetime: r.referencetime,
    time: requestedTime,
    format: requestedFormat,
    url_rest: productRestUrl(
      String(g.grid),
      String(p.package),
      r.referencetime,
      requestedTime,
      requestedFormat
    ),
    url_kvp: productKvpUrl(
      String(g.grid),
      String(p.package),
      r.referencetime,
      requestedTime,
      requestedFormat
    ),
  };
}

async function resolvePackageProduct(grid, pkg, time = "001H", format = "grib2") {
  const requestedTime = String(time || "001H").trim();
  const requestedFormat = String(format || "grib2").trim();

  const r = await autoPickReferenceTime(String(grid), String(pkg));
  if (!r.ok) return r;

  return {
    ok: true,
    model: MF_MODEL,
    grid: String(grid),
    package: String(pkg),
    referencetime: r.referencetime,
    time: requestedTime,
    format: requestedFormat,
    url_rest: productRestUrl(
      String(grid),
      String(pkg),
      r.referencetime,
      requestedTime,
      requestedFormat
    ),
    url_kvp: productKvpUrl(
      String(grid),
      String(pkg),
      r.referencetime,
      requestedTime,
      requestedFormat
    ),
  };
}

// ========================================================
// EXTRACTION PAR POINT
// ========================================================

async function extractPointValueFromPackage({
  grid,
  packageName,
  time = "001H",
  format = "grib2",
  point,
  variableKey,
}) {
  const cfg = VARIABLE_SPECS[variableKey];
  if (!cfg) {
    throw new Error(`unknown_variable_${variableKey}`);
  }

  let filePath = null;

  try {
    const product = await resolvePackageProduct(grid, packageName, time, format);
    if (!product.ok) {
      throw new Error(product.error || "package_product_resolve_failed");
    }

    filePath = await downloadProductToTempFile(product.url_rest);
    const raw = await gribGetData(filePath, cfg.shortName);
    const rows = parseGribGetData(raw.stdout);
    const nearest = nearestGridValue(rows, point.lat, point.lon);

    if (!nearest) {
      return {
        ok: false,
        error: "no_nearest_value_found",
        variable: variableKey,
        shortName: cfg.shortName,
      };
    }

    return {
      ok: true,
      variable: variableKey,
      shortName: cfg.shortName,
      package: packageName,
      grid,
      referencetime: product.referencetime,
      time: product.time,
      unit: cfg.unit,
      raw_value: nearest.value,
      nearest_grid_point: {
        lat: nearest.lat,
        lon: nearest.lon,
        distance_km: nearest.distance_km,
      },
      ...toResponsePayload(cfg, nearest.value),
    };
  } finally {
    await removeTempFile(filePath);
  }
}

async function extractPointValues(point, variableKeys, time = "001H", format = "grib2") {
  const g = await autoPickGrid();
  if (!g.ok) return g;

  const grouped = groupByPackage(variableKeys);
  const values = {};
  const meta = {};

  for (const [packageName, keys] of Object.entries(grouped)) {
    let filePath = null;

    try {
      const product = await resolvePackageProduct(g.grid, packageName, time, format);
      if (!product.ok) {
        for (const key of keys) {
          values[key] = null;
        }
        continue;
      }

      filePath = await downloadProductToTempFile(product.url_rest);

      for (const key of keys) {
        const cfg = VARIABLE_SPECS[key];
        const raw = await gribGetData(filePath, cfg.shortName);
        const rows = parseGribGetData(raw.stdout);
        const nearest = nearestGridValue(rows, point.lat, point.lon);

        if (!nearest) {
          values[key] = null;
          continue;
        }

        const converted =
          typeof cfg.convert === "function"
            ? cfg.convert(nearest.value)
            : nearest.value;

        values[key] = converted;

        meta[key] = {
          package: packageName,
          shortName: cfg.shortName,
          unit: cfg.unit,
          nearest_grid_point: {
            lat: nearest.lat,
            lon: nearest.lon,
            distance_km: nearest.distance_km,
          },
        };
      }
    } finally {
      await removeTempFile(filePath);
    }
  }

  return {
    ok: true,
    grid: g.grid,
    values,
    meta,
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
    mode: "AROME-OM catalogue + GRIB point extraction",
    model: MF_MODEL,
    product: MF_PRODUCT_ID,
    mf_base: MF_BASE,
    places_source: PLACES_SOURCE_URL,
    confirmed_variables: Object.keys(VARIABLE_SPECS),
    pending_variables: PENDING_VARIABLES,
    endpoints: [
      "/v1/arome/places",
      "/v1/arome/variables",
      "/v1/arome/model",
      "/v1/arome/grids",
      "/v1/arome/grids/auto",
      "/v1/arome/packages?grid=0.025",
      "/v1/arome/packages/auto?grid=0.025",
      "/v1/arome/package?grid=0.025&package=SP1",
      "/v1/arome/package/inventory?grid=0.025&package=SP2&time=001H",
      "/v1/arome/grib/version",
      "/v1/arome/product/inventory?time=001H",
      "/v1/arome/point/product/inventory?city=saint-denis&time=001H",
      "/v1/arome/point/value?city=saint-denis&variable=temp_2m&time=001H",
      "/v1/arome/point/basic?city=saint-denis&time=001H",
      "/v1/arome/point/thunder-risk?city=saint-denis&time=001H"
    ]
  });
});

app.get("/v1/arome/variables", (req, res) => {
  res.json({
    ok: true,
    confirmed: Object.fromEntries(
      Object.entries(VARIABLE_SPECS).map(([k, v]) => [
        k,
        {
          label: v.label,
          package: v.package,
          shortName: v.shortName,
          unit: v.unit,
          aliases: v.aliases,
        },
      ])
    ),
    pending: PENDING_VARIABLES,
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

app.get("/v1/arome/model", async (req, res) => {
  try {
    const j = await fetchJson(modelUrl());
    res.json({ ok: true, model: MF_MODEL, data: j });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "model_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/grids", async (req, res) => {
  try {
    const j = await getGrids();
    res.json({ ok: true, model: MF_MODEL, data: j });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "grids_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/grids/auto", async (req, res) => {
  try {
    const out = await autoPickGrid();
    res.status(out.ok ? 200 : 500).json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "grid_auto_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/packages", async (req, res) => {
  try {
    const grid = String(req.query.grid || "").trim();
    if (!grid) {
      return res.status(400).json({ ok: false, error: "grid_required" });
    }

    const j = await getPackages(grid);
    res.json({ ok: true, grid, data: j });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "packages_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/packages/auto", async (req, res) => {
  try {
    let grid = String(req.query.grid || "").trim();
    if (!grid) {
      const g = await autoPickGrid();
      if (!g.ok) return res.status(500).json(g);
      grid = String(g.grid);
    }

    const out = await autoPickPackage(grid);
    res.status(out.ok ? 200 : 500).json({ grid, ...out });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "package_auto_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/package", async (req, res) => {
  try {
    const grid = String(req.query.grid || "").trim();
    const pkg = String(req.query.package || "").trim();
    const referencetime = String(req.query.referencetime || "").trim() || null;

    if (!grid) return res.status(400).json({ ok: false, error: "grid_required" });
    if (!pkg) return res.status(400).json({ ok: false, error: "package_required" });

    const j = await getPackageDetails(grid, pkg, referencetime);
    res.json({ ok: true, grid, package: pkg, referencetime, data: j });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "package_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/product/url", async (req, res) => {
  try {
    const grid = String(req.query.grid || "").trim();
    const pkg = String(req.query.package || "").trim();
    const referencetime = String(req.query.referencetime || "").trim();
    const time = String(req.query.time || "").trim();
    const format = String(req.query.format || "grib2").trim();

    if (!grid) return res.status(400).json({ ok: false, error: "grid_required" });
    if (!pkg) return res.status(400).json({ ok: false, error: "package_required" });
    if (!referencetime) return res.status(400).json({ ok: false, error: "referencetime_required" });
    if (!time) return res.status(400).json({ ok: false, error: "time_required" });

    res.json({
      ok: true,
      grid,
      package: pkg,
      referencetime,
      time,
      format,
      url_rest: productRestUrl(grid, pkg, referencetime, time, format),
      url_kvp: productKvpUrl(grid, pkg, referencetime, time, format),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "product_url_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/product/download", async (req, res) => {
  try {
    const grid = String(req.query.grid || "").trim();
    const pkg = String(req.query.package || "").trim();
    const referencetime = String(req.query.referencetime || "").trim();
    const time = String(req.query.time || "").trim();
    const format = String(req.query.format || "grib2").trim();

    if (!grid) return res.status(400).json({ ok: false, error: "grid_required" });
    if (!pkg) return res.status(400).json({ ok: false, error: "package_required" });
    if (!referencetime) return res.status(400).json({ ok: false, error: "referencetime_required" });
    if (!time) return res.status(400).json({ ok: false, error: "time_required" });

    const url = productRestUrl(grid, pkg, referencetime, time, format);
    const out = await fetchBuffer(url);

    res.setHeader("Content-Type", out.ct);
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(Buffer.from(out.buf));
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "product_download_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/product/auto", async (req, res) => {
  try {
    const out = await resolveAutoProduct(
      String(req.query.time || "001H"),
      String(req.query.format || "grib2")
    );

    if (!out.ok) return res.status(500).json(out);

    res.json({
      ...out,
      note: "URL du produit auto-résolu.",
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "product_auto_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/point/product/auto", async (req, res) => {
  try {
    const point = await getPoint(req);
    const out = await resolveAutoProduct(
      String(req.query.time || "001H"),
      String(req.query.format || "grib2")
    );

    if (!out.ok) return res.status(500).json(out);

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      ...out,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "point_product_auto_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/grib/version", async (req, res) => {
  try {
    const out = await gribLsVersion();
    res.json({
      ok: true,
      tool: "grib_ls",
      stdout: out.stdout,
      stderr: out.stderr,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "grib_version_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/product/inventory", async (req, res) => {
  let filePath = null;

  try {
    const out = await resolveAutoProduct(
      String(req.query.time || "001H"),
      String(req.query.format || "grib2")
    );

    if (!out.ok) return res.status(500).json(out);

    filePath = await downloadProductToTempFile(out.url_rest);
    const inv = await gribLsInventory(filePath);

    res.json({
      ok: true,
      model: out.model,
      grid: out.grid,
      package: out.package,
      referencetime: out.referencetime,
      time: out.time,
      format: out.format,
      temp_file: filePath,
      inventory: inv.stdout,
      stderr: inv.stderr,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "product_inventory_failed",
      message: String(e?.message || e),
    });
  } finally {
    await removeTempFile(filePath);
  }
});

app.get("/v1/arome/point/product/inventory", async (req, res) => {
  let filePath = null;

  try {
    const point = await getPoint(req);
    const out = await resolveAutoProduct(
      String(req.query.time || "001H"),
      String(req.query.format || "grib2")
    );

    if (!out.ok) return res.status(500).json(out);

    filePath = await downloadProductToTempFile(out.url_rest);
    const inv = await gribLsInventory(filePath);

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      model: out.model,
      grid: out.grid,
      package: out.package,
      referencetime: out.referencetime,
      time: out.time,
      format: out.format,
      temp_file: filePath,
      inventory: inv.stdout,
      stderr: inv.stderr,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "point_product_inventory_failed",
      message: String(e?.message || e),
    });
  } finally {
    await removeTempFile(filePath);
  }
});

app.get("/v1/arome/package/inventory", async (req, res) => {
  let filePath = null;

  try {
    const grid = String(req.query.grid || "").trim();
    const pkg = String(req.query.package || "").trim();
    const time = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    if (!grid) {
      return res.status(400).json({ ok: false, error: "grid_required" });
    }
    if (!pkg) {
      return res.status(400).json({ ok: false, error: "package_required" });
    }

    const out = await resolvePackageProduct(grid, pkg, time, format);
    if (!out.ok) return res.status(500).json(out);

    filePath = await downloadProductToTempFile(out.url_rest);
    const inv = await gribLsInventory(filePath);

    res.json({
      ok: true,
      model: out.model,
      grid: out.grid,
      package: out.package,
      referencetime: out.referencetime,
      time: out.time,
      format: out.format,
      inventory: inv.stdout,
      stderr: inv.stderr,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "package_inventory_failed",
      message: String(e?.message || e),
    });
  } finally {
    await removeTempFile(filePath);
  }
});

app.get("/v1/arome/point/value", async (req, res) => {
  try {
    const point = await getPoint(req);
    const variableRaw = String(req.query.variable || req.query.var || "").trim();
    const time = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    const variableKey = normalizeVariableName(variableRaw);
    if (!variableKey) {
      return res.status(400).json({
        ok: false,
        error: "unknown_variable",
        message: "Utilise /v1/arome/variables pour voir la liste confirmée.",
      });
    }

    const cfg = VARIABLE_SPECS[variableKey];
    const g = await autoPickGrid();
    if (!g.ok) return res.status(500).json(g);

    const out = await extractPointValueFromPackage({
      grid: g.grid,
      packageName: cfg.package,
      time,
      format,
      point,
      variableKey,
    });

    if (!out.ok) {
      return res.status(500).json(out);
    }

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      ...out,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "point_value_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/point/basic", async (req, res) => {
  try {
    const point = await getPoint(req);
    const time = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    const keys = [
      "pressure_msl",
      "pressure_surface",
      "wind_dir_10m",
      "wind_u_10m",
      "wind_gust_10m",
      "rh_2m",
      "temp_2m",
      "dewpoint_2m",
      "precip_total",
      "precip_rate",
      "solar_downward",
      "cloud_low",
      "cloud_mid",
      "cloud_high",
      "cape",
      "boundary_layer_height",
    ];

    const out = await extractPointValues(point, keys, time, format);
    if (!out.ok) return res.status(500).json(out);

    const apparent = computeApparentTemperature(
      out.values.temp_2m,
      out.values.rh_2m,
      out.values.wind_gust_10m
    );

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      grid: out.grid,
      time,
      values: {
        ...out.values,
        apparent_temperature: apparent,
      },
      meta: out.meta,
      pending_variables: PENDING_VARIABLES,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "point_basic_failed",
      message: String(e?.message || e),
    });
  }
});

app.get("/v1/arome/point/thunder-risk", async (req, res) => {
  try {
    const point = await getPoint(req);
    const time = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    const keys = [
      "cape",
      "dewpoint_2m",
      "rh_2m",
      "precip_rate",
      "precip_total",
      "wind_gust_10m",
      "cloud_low",
      "cloud_mid",
      "cloud_high",
      "boundary_layer_height",
      "temp_2m",
      "pressure_msl",
      "pressure_surface",
    ];

    const out = await extractPointValues(point, keys, time, format);
    if (!out.ok) return res.status(500).json(out);

    const risk = computeThunderstormRisk(out.values);

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      grid: out.grid,
      time,
      variables_used: out.values,
      risk,
      notes: [
        "Score basé uniquement sur les variables AROME confirmées disponibles.",
        "La densité de foudre et l’UV ne sont pas encore intégrés.",
        "La nébulosité convective n’est pas encore confirmée dans l’inventaire partagé.",
      ],
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "thunder_risk_failed",
      message: String(e?.message || e),
    });
  }
});

app.listen(PORT, () => {
  console.log("CycloneOI AROME API listening on", PORT);
});
