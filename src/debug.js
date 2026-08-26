// Debug-Pfad: erzwingt jeden UI-Zustand ueber ?state=. Wird nur bei gesetztem
// Parameter dynamisch geladen (siehe main.js), kostet im Normalbetrieb nichts.
//
// Zustaende: loading, ok, rainNow, stale, veryStale, error, offline, noGeo,
// noCoverage sowie alerts und alertsEmpty fuer den Warnungen-Reiter.

import { computeNowcast } from "./nowcast.js";
import { summarize } from "./text.js";
import { CONFIG } from "./config.js";
import { render, renderAlerts, setTab, setAlertBadge } from "./ui.js";
import { normalizeAlerts } from "./alerts.js";

const MIN = 60_000;
const GRID = 41; // wie der echte Ausschnitt (~41x41)
const C = 20; // Mittelpunkt (Standort)

// Ein Frame mit einem gauss-foermigen Regengebiet, dessen Zentrum sich bewegt.
function blobFrame(i, { peak, x0, vx, y0 = C, sigma = 5 }) {
  const bx = x0 + vx * i;
  const grid = [];
  for (let r = 0; r < GRID; r++) {
    const row = [];
    for (let c = 0; c < GRID; c++) {
      const d2 = (c - bx) ** 2 + (r - y0) ** 2;
      row.push(Math.round(peak * Math.exp(-d2 / (2 * sigma * sigma))));
    }
    grid.push(row);
  }
  return grid;
}

// RadarSeries mit ziehendem Regengebiet, Frame 0 auf `now`.
function blobSeries(now, opts) {
  const n = 25;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const validTime = new Date(now.getTime() + i * 5 * MIN);
    frames.push({ validTime, grid: blobFrame(i, opts), isForecast: validTime.getTime() > now.getTime() });
  }
  return {
    fetchedAt: now,
    runTime: new Date(now.getTime() - (opts.runOffsetMin || 0) * MIN),
    center: { row: C, col: C },
    coords: { lat: 52.52, lon: 13.405 },
    frames,
  };
}

function nullSeries(now) {
  const frames = [];
  for (let i = 0; i < 25; i++) {
    const validTime = new Date(now.getTime() + i * 5 * MIN);
    const grid = Array.from({ length: GRID }, () => Array(GRID).fill(null));
    frames.push({ validTime, grid, isForecast: validTime.getTime() > now.getTime() });
  }
  return { fetchedAt: now, runTime: now, center: { row: C, col: C }, coords: { lat: 52.52, lon: 13.405 }, frames };
}

// Regengebiet zieht heran und ueber den Standort (~+40 min), dann weiter.
const approaching = (now, runOffsetMin = 0) =>
  blobSeries(now, { peak: 90, x0: 4, vx: 2, runOffsetMin });
// Regengebiet steht jetzt ueber dem Standort und zieht ab.
const rainingNow = (now) => blobSeries(now, { peak: 80, x0: C, vx: 1.5 });

const PLACE = { name: "Berlin" };
const CHIPS = [{ id: "geo", name: "Berlin" }];

function base(extra) {
  return { place: PLACE, places: CHIPS, activePlaceId: "geo", ...extra };
}

// Beispielwarnungen im Antwortformat von Bright Sky, damit der Reiter ohne Netz
// geprueft werden kann.
function demoAlerts(now) {
  const iso = (h) => new Date(now.getTime() + h * 3600000).toISOString();
  return {
    location: { name: "Berl. - Mitte", state: "Berlin" },
    alerts: [
      { id: 1, event_de: "GEWITTER", event_code: 31, severity: "severe",
        headline_de: "Amtliche UNWETTERWARNUNG vor SCHWEREM GEWITTER",
        description_de: "Es treten Gewitter mit Orkanböen bis 120 km/h und Hagel auf.",
        instruction_de: "Meiden Sie den Aufenthalt im Freien.", onset: iso(1), expires: iso(5) },
      { id: 2, event_de: "WINDBÖEN", event_code: 51, severity: "minor",
        headline_de: "Amtliche Warnung vor WINDBÖEN",
        description_de: "Es treten Windböen mit Geschwindigkeiten um 55 km/h auf.",
        instruction_de: null, onset: iso(-2), expires: iso(9) },
      { id: 3, event_de: "FROST", event_code: 22, severity: "minor",
        headline_de: "Amtliche Warnung vor FROST",
        description_de: "Die Temperatur sinkt in Bodennähe auf Werte um den Gefrierpunkt.",
        instruction_de: null, onset: iso(14), expires: iso(20) },
    ],
  };
}

function showAlerts(now, raw) {
  document.body.dataset.state = "ok";
  setTab("alerts");
  const data = { ...normalizeAlerts(raw), fetchedAt: now };
  setAlertBadge(data.count);
  renderAlerts({ state: "ok", place: PLACE, alerts: data });
}

export function renderDebug(stateName) {
  const now = new Date();
  const ncFrom = (series) => {
    const nowcast = computeNowcast(series, now, CONFIG);
    return { nowcast, summary: summarize(nowcast) };
  };
  const show = (state, series, extra = {}) => {
    const { nowcast, summary } = ncFrom(series);
    render(base({
      state,
      summary,
      nowcast,
      coords: series.coords,
      fetchedAt: series.fetchedAt,
      temperature: 15.4,
      ...extra,
    }));
  };

  switch (stateName) {
    case "alerts":
      showAlerts(now, demoAlerts(now));
      return;
    case "alertsEmpty":
      showAlerts(now, { alerts: [], location: { name: "Berl. - Mitte" } });
      return;
    case "loading":
      render(base({ state: "loading", summary: null, nowcast: null }));
      return;
    case "ok":
      show("ok", approaching(now));
      return;
    case "rainNow":
      show("ok", rainingNow(now));
      return;
    case "stale":
      show("stale", approaching(now, 20));
      return;
    case "veryStale":
      show("veryStale", approaching(now, 40));
      return;
    case "noCoverage":
      show("noCoverage", nullSeries(now));
      return;
    case "error":
      show("error", approaching(now), { error: { kind: "http" } });
      return;
    case "offline":
      show("offline", approaching(now));
      return;
    case "noGeo":
      show("noGeo", approaching(now));
      return;
    default:
      render(base({ state: "error", summary: null, nowcast: null, error: { kind: "shape" } }));
  }
}
