// Amtliche DWD-Warnmeldungen ueber den /alerts-Endpoint von Bright Sky.
// Wie api.js das einzige Modul mit Wissen ueber das Antwortformat. Normalisiert
// die Antwort in eine nach Ereignisart gruppierte, sortierte Liste.

import { API_BASE, FETCH_TIMEOUT_MS } from "./config.js";
import { ApiError } from "./api.js";

// DWD-Warnstufe aus der CAP-Severity. Farben und Nummern der Stufen sind im
// Warnkonzept des DWD festgelegt: 1 gelb, 2 orange, 3 rot, 4 violett.
const LEVEL = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
const LEVEL_LABEL = {
  1: "Wetterwarnung",
  2: "Markantes Wetter",
  3: "Unwetterwarnung",
  4: "Extremes Unwetter",
};

/** Warnstufe 1..4 einer Warnung. Unbekannte Severity gilt als Stufe 1. */
export function levelOf(severity) {
  return LEVEL[severity] ?? 1;
}

export function levelLabel(level) {
  return LEVEL_LABEL[level] ?? LEVEL_LABEL[1];
}

function date(value) {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Der DWD liefert dieselbe Warnung fuer mehrere Warnzellen mehrfach. Gleiche
// Ereignisart, Stufe und Zeitspanne gelten als eine Warnung.
function dedupeKey(a) {
  return [a.eventCode, a.level, a.onset?.getTime() ?? "", a.expires?.getTime() ?? "", a.description].join("|");
}

/**
 * @typedef {{
 *   id: number, event: string, eventCode: number, level: number,
 *   headline: string|null, description: string|null, instruction: string|null,
 *   onset: Date|null, expires: Date|null
 * }} Alert
 * @typedef {{ event: string, level: number, alerts: Alert[] }} AlertGroup
 */

/**
 * Rohantwort -> { location, groups }. Gruppen nach Ereignisart, absteigend nach
 * Warnstufe und danach nach Beginn sortiert.
 * @returns {{
 *   location: {name: string|null, fullName: string|null, district: string|null, state: string|null}|null,
 *   groups: AlertGroup[],
 *   count: number
 * }}
 */
export function normalizeAlerts(data) {
  const raw = Array.isArray(data?.alerts) ? data.alerts : null;
  if (raw === null) throw new ApiError("shape", "Feld alerts fehlt oder ist kein Array");

  const seen = new Set();
  const alerts = [];
  for (const a of raw) {
    const alert = {
      id: a.id,
      event: typeof a.event_de === "string" && a.event_de ? a.event_de : "WARNUNG",
      eventCode: typeof a.event_code === "number" ? a.event_code : -1,
      level: levelOf(a.severity),
      headline: a.headline_de ?? null,
      description: a.description_de ?? null,
      instruction: a.instruction_de ?? null,
      onset: date(a.onset) ?? date(a.effective),
      expires: date(a.expires),
    };
    const key = dedupeKey(alert);
    if (seen.has(key)) continue;
    seen.add(key);
    alerts.push(alert);
  }

  const byEvent = new Map();
  for (const a of alerts) {
    const g = byEvent.get(a.event);
    if (g) g.alerts.push(a);
    else byEvent.set(a.event, { event: a.event, level: a.level, alerts: [a] });
  }

  const groups = [...byEvent.values()];
  for (const g of groups) {
    g.alerts.sort((x, y) => y.level - x.level || (x.onset?.getTime() ?? 0) - (y.onset?.getTime() ?? 0));
    g.level = g.alerts[0].level;
  }
  groups.sort((a, b) => b.level - a.level || a.event.localeCompare(b.event, "de"));

  // name ist der amtliche Warnzellenname und wird sehr lang ("Mitgliedsgemeinde
  // in Verwaltungsgemeinschaft ..."), name_short ist die Kurzform des DWD.
  const loc = data?.location ?? null;
  return {
    location: loc
      ? {
          name: loc.name_short ?? loc.name ?? null,
          fullName: loc.name ?? null,
          district: loc.district ?? null,
          state: loc.state ?? null,
        }
      : null,
    groups,
    count: alerts.length,
  };
}

/**
 * @param {{ lat: number, lon: number, fetchImpl?: typeof fetch }} args
 * @returns {Promise<ReturnType<typeof normalizeAlerts> & { fetchedAt: Date }>}
 */
export async function fetchAlerts({ lat, lon, now, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  const url = `${API_BASE}/alerts?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === "AbortError" || controller.signal.aborted)) {
      throw new ApiError("timeout", `Zeitueberschreitung nach ${FETCH_TIMEOUT_MS} ms`);
    }
    throw new ApiError("network", err?.message ?? "Netzwerkfehler");
  }
  clearTimeout(timer);

  if (!res.ok) throw new ApiError("http", `HTTP ${res.status}`, res.status);

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new ApiError("shape", "Antwort ist kein gueltiges JSON");
  }

  return { ...normalizeAlerts(data), fetchedAt: now ?? new Date() };
}
