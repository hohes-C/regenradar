// Einziges Modul mit Wissen ueber die Bright-Sky-Antwort. Normalisiert den
// /radar-Endpoint in eine RadarSeries. Spaeter (Stufe 2) zeigt API_BASE auf ein
// eigenes Backend; nur dieses Modul muesste dann angepasst werden.

import {
  API_BASE,
  DISTANCE_M,
  PAST_MIN,
  HORIZON_MIN,
  FRAME_MIN,
  FETCH_TIMEOUT_MS,
  FAR_WINDOW,
} from "./config.js";

const MIN = 60_000;

/**
 * @typedef {{
 *   fetchedAt: Date,
 *   runTime: Date | null,
 *   center: { row: number, col: number },
 *   coords: { lat: number, lon: number },
 *   frames: Array<{ validTime: Date, grid: (number|null)[][], isForecast: boolean }>
 * }} RadarSeries
 */

/** Fehler mit unterscheidbarer `kind`: network|timeout|http|empty|shape. */
export class ApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildUrl({ lat, lon, now }) {
  const date = new Date(now.getTime() - PAST_MIN * MIN);
  const lastDate = new Date(now.getTime() + (HORIZON_MIN + FRAME_MIN) * MIN);
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    distance: String(DISTANCE_M),
    format: "plain",
    date: iso(date),
    last_date: iso(lastDate),
  });
  return `${API_BASE}/radar?${params.toString()}`;
}

// Zeitstempel des Vorhersage-Laufs hinter dem letzten "::" in `source`.
function runTimeFromSource(source) {
  if (typeof source !== "string") return null;
  const idx = source.lastIndexOf("::");
  if (idx < 0) return null;
  const stamp = source.slice(idx + 2);
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Fehlwerte (negativ) werden zu null, echte null bleiben null.
function normalizeGrid(grid) {
  return grid.map((row) =>
    row.map((v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || v < 0) return null;
      return v;
    })
  );
}

function resolveCenter(pos, rows, cols) {
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    const col = Math.round(pos.x);
    const row = Math.round(pos.y);
    if (row >= 0 && row < rows && col >= 0 && col < cols) return { row, col };
  }
  return { row: Math.floor(rows / 2), col: Math.floor(cols / 2) };
}

function normalize(data, now, coords) {
  const records = Array.isArray(data?.radar) ? data.radar : null;
  if (records === null) throw new ApiError("shape", "Feld radar fehlt oder ist kein Array");
  if (records.length === 0) throw new ApiError("empty", "Keine Radar-Records");

  // runTime = groesster Lauf-Zeitstempel ueber alle Records.
  let runTime = null;
  for (const rec of records) {
    const rt = runTimeFromSource(rec.source);
    if (rt && (!runTime || rt.getTime() > runTime.getTime())) runTime = rt;
  }

  // Frames aufbauen, Records ohne precipitation_5 ueberspringen, nach validTime
  // deduplizieren (letzter gewinnt).
  const byTime = new Map();
  for (const rec of records) {
    if (rec.precipitation_5 === null || rec.precipitation_5 === undefined) continue;
    if (!Array.isArray(rec.precipitation_5) || !Array.isArray(rec.precipitation_5[0])) {
      throw new ApiError("shape", "precipitation_5 ist kein 2D-Array");
    }
    const validTime = new Date(rec.timestamp);
    if (Number.isNaN(validTime.getTime())) {
      throw new ApiError("shape", "Ungueltiger timestamp");
    }
    const grid = normalizeGrid(rec.precipitation_5);
    byTime.set(validTime.getTime(), { validTime, grid });
  }

  if (byTime.size === 0) throw new ApiError("empty", "Keine Records mit Daten");

  const entries = [...byTime.values()].sort(
    (a, b) => a.validTime.getTime() - b.validTime.getTime()
  );

  const rows = entries[0].grid.length;
  const cols = entries[0].grid[0].length;
  if (rows < FAR_WINDOW || cols < FAR_WINDOW) {
    throw new ApiError("shape", `Ausschnitt ${rows}x${cols} kleiner als ${FAR_WINDOW}x${FAR_WINDOW}`);
  }

  const center = resolveCenter(data.latlon_position, rows, cols);

  const frames = entries.map((e) => ({
    validTime: e.validTime,
    grid: e.grid,
    isForecast: runTime ? e.validTime.getTime() > runTime.getTime() : false,
  }));

  return { fetchedAt: now, runTime, center, coords, frames };
}

/**
 * @param {{ lat: number, lon: number, now: Date, fetchImpl?: typeof fetch }} args
 * @returns {Promise<RadarSeries>}
 */
export async function fetchRadarSeries({ lat, lon, now, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = buildUrl({ lat, lon, now });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === "AbortError" || controller.signal.aborted)) {
      throw new ApiError("timeout", `Zeitueberschreitung nach ${FETCH_TIMEOUT_MS} ms`);
    }
    throw new ApiError("network", err?.message ?? "Netzwerkfehler");
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new ApiError("http", `HTTP ${res.status}`, res.status);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new ApiError("network", err?.message ?? "Antwort nicht lesbar");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError("shape", "Antwort ist kein gueltiges JSON");
  }

  return normalize(data, now, { lat, lon });
}

/**
 * Name der naechstgelegenen DWD-Station als Ortslabel. Dekorativ, wirft nie:
 * bei jedem Fehler kommt null zurueck. Bleibt bei der einen erlaubten API.
 * @param {{ lat: number, lon: number, fetchImpl?: typeof fetch }} args
 * @returns {Promise<string|null>}
 */
export async function fetchPlaceName({ lat, lon, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = `${API_BASE}/sources?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    let nearest = null;
    for (const s of sources) {
      const d = typeof s.distance === "number" ? s.distance : Infinity;
      if (!nearest || d < nearest.distance) nearest = { distance: d, name: s.station_name };
    }
    return nearest && typeof nearest.name === "string" ? nearest.name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
