import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

const MF_BASE = "https://public-api.meteofrance.fr/public/pearome/1.0/";
const RUN_DEFAULT = "001";

function capabilitiesUrl(run) {
  return `${MF_BASE}wcs/MF-NWP-HIGHRES-PEARO${run}-OM-0025-INDIEN-WCS/GetCapabilities?service=WCS&version=2.0.1&language=fre`;
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

// ---- helpers pluie ----
function pickRainIds(ids, stamp) {
  // On cherche les IDs EXACTS du run stamp, et les produits de pluie
  // Vu ta capture, c'est TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE__<stamp>_PT1H
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
    p1d: pick("_P1D"), // parfois dispo
    p2d: pick("_P2D")
  };
}

// ===== Routes =====

app.get("/", (req, res) => {
  res.json({ ok: true, service: "CycloneOI AROME API", status: "running" });
});

// Capabilities XML brut (pour debug)
app.get("/v1/arome/capabilities", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const r = await fetch(capabilitiesUrl(run), {
      headers: { apikey: process.env.AROME_APIKEY || "" }
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: "capabilities_failed", message: String(e?.message || e) });
  }
});

// Debug IDs filtrés
app.get("/v1/arome/ids", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);
    const filter = String(req.query.filter || "").toUpperCase();

    const r = await fetch(capabilitiesUrl(run), {
      headers: { apikey: process.env.AROME_APIKEY || "" }
    });

    const xml = await r.text();
    const ids = extractCoverageIds(xml);

    const filtered = filter ? ids.filter((x) => x.toUpperCase().includes(filter)) : ids;

    res.json({ ok: true, run, filter: filter || null, count: filtered.length, sample: filtered.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "ids_failed", message: String(e?.message || e) });
  }
});

// ✅ Nouveau: pluie latest (mapping propre)
app.get("/v1/arome/rain/latest", async (req, res) => {
  try {
    const run = String(req.query.run || RUN_DEFAULT);

    const r = await fetch(capabilitiesUrl(run), {
      headers: { apikey: process.env.AROME_APIKEY || "" }
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: "mf_error", status: r.status, detail: xml.slice(0, 300) });
    }

    const ids = extractCoverageIds(xml);
    const stamp = latestRunStamp(ids);
    if (!stamp) return res.status(502).json({ ok: false, error: "no_run_stamp_found" });

    // On ne garde que les IDs qui contiennent PRECIP (pour limiter)
    const precipIds = ids.filter((x) => x.includes("PRECIPITATION"));
    const rain = pickRainIds(precipIds, stamp);

    res.json({
      ok: true,
      run,
      latest_run_stamp: stamp,
      rain
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "rain_latest_failed", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("CycloneOI AROME API listening on", PORT));
