import express from "express";

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

// Auth: swagger = security OAuth2.
// En pratique on envoie un Bearer si dispo.
// Si ton infra utilisait encore une clé simple, on garde aussi un fallback apikey.
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
// HELPERS
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

function isoUtcNoMs(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hourTokenFromInt(h) {
  const n = clamp(parseInt(String(h || 0), 10) || 0, 0, 999);
  return `${String(n).padStart(3, "0")}H`;
}

function buildMfHeaders(accept = "application/json") {
  const headers = { accept };
  if (MF_BEARER_TOKEN) headers.Authorization = `Bearer ${MF_BEARER_TOKEN}`;
  if (MF_APIKEY) headers.apikey = MF_APIKEY;
  return headers;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: buildMfHeaders("application/json,text/json,*/*") });
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`upstream_${r.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`json_parse_failed: ${text.slice(0, 500)}`);
  }
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
// MFR API URLS
// ========================================================

function modelUrl() {
  return `${MF_BASE}/models/${MF_MODEL}`;
}

function gridsUrl() {
  return `${MF_BASE}/models/${MF_MODEL}/grids`;
}

function gridUrl(grid) {
  return `${MF_BASE}/models/${MF_MODEL}/grids/${encodeURIComponent(grid)}`;
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
// AUTO-SELECTION HELPERS
// ========================================================

async function getGrids() {
  return await fetchJson(gridsUrl());
}

function normalizeArrayPayload(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.grids)) return json.grids;
  if (Array.isArray(json?.packages)) return json.packages;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.products)) return json.products;
  if (Array.isArray(json?.links)) return json.links;
  if (Array.isArray(json?.data?.links)) return json.data.links;
  return [];
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

  // On prend un lien qui termine par /grids/<valeur>
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

  const grid = decodeURIComponent(m[1]);

  return {
    ok: true,
    grid,
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
    .filter(Boolean);

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
  const candidates =
    j?.referencetimes ||
    j?.referenceTimes ||
    j?.references ||
    j?.runs ||
    j?.data ||
    [];

  if (Array.isArray(candidates)) {
    return candidates
      .map((x) => x?.referencetime || x?.referenceTime || x?.value || x)
      .filter(Boolean);
  }
  return [];
}

function extractTimes(j) {
  const candidates =
    j?.times ||
    j?.echeances ||
    j?.products ||
    j?.data ||
    [];

  if (Array.isArray(candidates)) {
    return candidates
      .map((x) => x?.time || x?.echeance || x?.value || x)
      .filter(Boolean);
  }
  return [];
}

async function autoPickReferenceTime(grid, pkg) {
  const j = await getPackageDetails(grid, pkg);
  const refs = extractReferenceTimes(j);

  if (refs.length) {
    const sorted = refs.slice().sort();
    return { ok: true, referencetime: sorted[sorted.length - 1], raw: j };
  }

  // fallback: now arrondi à l’heure UTC
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return { ok: true, referencetime: isoUtcNoMs(d), raw: j, fallback: true };
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
    mode: "AROME-OM catalogue + product download proxy",
    model: MF_MODEL,
    product: MF_PRODUCT_ID,
    mf_base: MF_BASE,
    places_source: PLACES_SOURCE_URL,
    note: "Cette version utilise la bonne API Paquet Modèles. Elle télécharge/proxyfie productOMOI en GRIB2 mais ne parse pas encore les messages GRIB2 par variable/point.",
    endpoints: [
      "/v1/arome/places",
      "/v1/arome/model",
      "/v1/arome/grids",
      "/v1/arome/grids/auto",
      "/v1/arome/packages?grid=...",
      "/v1/arome/packages/auto?grid=...",
      "/v1/arome/package?grid=...&package=SP1",
      "/v1/arome/package/auto?grid=...&package=SP1",
      "/v1/arome/product/url?grid=...&package=SP1&referencetime=...&time=001H",
      "/v1/arome/product/download?grid=...&package=SP1&referencetime=...&time=001H",
      "/v1/arome/product/auto?time=001H",
      "/v1/arome/point/product/auto?city=saint-denis&time=001H"
    ]
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
    res.status(500).json({ ok: false, error: "model_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/grids", async (req, res) => {
  try {
    const j = await getGrids();
    res.json({ ok: true, model: MF_MODEL, data: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: "grids_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/grids/auto", async (req, res) => {
  try {
    const out = await autoPickGrid();
    res.status(out.ok ? 200 : 500).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: "grid_auto_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/packages", async (req, res) => {
  try {
    const grid = String(req.query.grid || "").trim();
    if (!grid) return res.status(400).json({ ok: false, error: "grid_required" });

    const j = await getPackages(grid);
    res.json({ ok: true, grid, data: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: "packages_failed", message: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: "package_auto_failed", message: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: "package_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/package/auto", async (req, res) => {
  try {
    let grid = String(req.query.grid || "").trim();
    let pkg = String(req.query.package || "").trim();

    if (!grid) {
      const g = await autoPickGrid();
      if (!g.ok) return res.status(500).json(g);
      grid = String(g.grid);
    }

    if (!pkg) {
      const p = await autoPickPackage(grid);
      if (!p.ok) return res.status(500).json(p);
      pkg = String(p.package);
    }

    const ref = await autoPickReferenceTime(grid, pkg);
    res.status(ref.ok ? 200 : 500).json({
      ok: ref.ok,
      grid,
      package: pkg,
      referencetime: ref.referencetime,
      fallback: !!ref.fallback,
      raw: ref.raw
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "package_auto_failed", message: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: "product_url_failed", message: String(e?.message || e) });
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
    res.status(500).json({ ok: false, error: "product_download_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/product/auto", async (req, res) => {
  try {
    const requestedTime = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    const g = await autoPickGrid();
    if (!g.ok) return res.status(500).json(g);

    const p = await autoPickPackage(String(g.grid));
    if (!p.ok) return res.status(500).json(p);

    const r = await autoPickReferenceTime(String(g.grid), String(p.package));
    if (!r.ok) return res.status(500).json(r);

    res.json({
      ok: true,
      model: MF_MODEL,
      grid: String(g.grid),
      package: String(p.package),
      referencetime: r.referencetime,
      time: requestedTime,
      format,
      url_rest: productRestUrl(String(g.grid), String(p.package), r.referencetime, requestedTime, format),
      url_kvp: productKvpUrl(String(g.grid), String(p.package), r.referencetime, requestedTime, format),
      note: "Étape suivante: parser le GRIB2 téléchargé pour extraire les variables par point."
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "product_auto_failed", message: String(e?.message || e) });
  }
});

app.get("/v1/arome/point/product/auto", async (req, res) => {
  try {
    const point = await getPoint(req);
    const requestedTime = String(req.query.time || "001H").trim();
    const format = String(req.query.format || "grib2").trim();

    const g = await autoPickGrid();
    if (!g.ok) return res.status(500).json(g);

    const p = await autoPickPackage(String(g.grid));
    if (!p.ok) return res.status(500).json(p);

    const r = await autoPickReferenceTime(String(g.grid), String(p.package));
    if (!r.ok) return res.status(500).json(r);

    res.json({
      ok: true,
      point_source: point.source,
      city: point.city,
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      model: MF_MODEL,
      grid: String(g.grid),
      package: String(p.package),
      referencetime: r.referencetime,
      time: requestedTime,
      format,
      url_rest: productRestUrl(String(g.grid), String(p.package), r.referencetime, requestedTime, format),
      url_kvp: productKvpUrl(String(g.grid), String(p.package), r.referencetime, requestedTime, format),
      note: "Le point est résolu, mais cette version ne lit pas encore le contenu GRIB2."
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "point_product_auto_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("CycloneOI AROME API listening on", PORT);
});
