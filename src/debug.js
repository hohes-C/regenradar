// Debug-Pfad: erzwingt jeden UI-Zustand ueber ?state=. Wird nur bei gesetztem
// Parameter dynamisch geladen (siehe main.js), kostet im Normalbetrieb nichts.
//
// Zustaende: loading, ok, stale, veryStale, error, offline, noGeo, noCoverage.

import { computeNowcast } from "./nowcast.js";
import { summarize } from "./text.js";
import { CONFIG } from "./config.js";
import { render } from "./ui.js";

const MIN = 60_000;

// Baut eine RadarSeries aus Zentrumswerten, Frame 0 auf `now`.
function buildSeries(centerValues, { now, runOffsetMin = 0 } = {}) {
  const frames = centerValues.map((val, i) => {
    const validTime = new Date(now.getTime() + i * 5 * MIN);
    const grid =
      val === null
        ? Array.from({ length: 5 }, () => Array(5).fill(null))
        : Array.from({ length: 5 }, () => Array(5).fill(val));
    return { validTime, grid, isForecast: validTime.getTime() > now.getTime() };
  });
  return {
    fetchedAt: now,
    runTime: new Date(now.getTime() - runOffsetMin * MIN),
    center: { row: 2, col: 2 },
    frames,
  };
}

// Szenario: trocken jetzt, dann Regen ab +25 min bis +70 min, danach trocken.
function rainySeries(now, runOffsetMin = 0) {
  const values = new Array(25).fill(0);
  for (let i = 6; i <= 14; i++) values[i] = i < 10 ? 20 : 60; // leicht -> stark
  return buildSeries(values, { now, runOffsetMin });
}

const PLACE = { name: "Berlin" };
const CHIPS = [{ id: "geo", name: "Berlin" }];

function base(extra) {
  return { place: PLACE, places: CHIPS, activePlaceId: "geo", ...extra };
}

export function renderDebug(stateName) {
  const now = new Date();

  const ncFrom = (series) => {
    const nowcast = computeNowcast(series, now, CONFIG);
    return { nowcast, summary: summarize(nowcast) };
  };

  switch (stateName) {
    case "loading":
      render(base({ state: "loading", summary: null, nowcast: null }));
      return;

    case "ok": {
      const { nowcast, summary } = ncFrom(rainySeries(now));
      render(base({ state: "ok", summary, nowcast }));
      return;
    }
    case "stale": {
      const { nowcast, summary } = ncFrom(rainySeries(now, 20));
      render(base({ state: "stale", summary, nowcast }));
      return;
    }
    case "veryStale": {
      const { nowcast, summary } = ncFrom(rainySeries(now, 40));
      render(base({ state: "veryStale", summary, nowcast }));
      return;
    }
    case "noCoverage": {
      const { nowcast, summary } = ncFrom(buildSeries(new Array(25).fill(null), { now }));
      render(base({ state: "noCoverage", summary, nowcast }));
      return;
    }
    case "error": {
      const { nowcast, summary } = ncFrom(rainySeries(now));
      // Letztes Ergebnis bleibt sichtbar, Banner zeigt Fehler.
      render(base({ state: "error", summary, nowcast, error: { kind: "http" } }));
      return;
    }
    case "offline": {
      const { nowcast, summary } = ncFrom(rainySeries(now));
      render(base({ state: "offline", summary, nowcast }));
      return;
    }
    case "noGeo": {
      const { nowcast, summary } = ncFrom(rainySeries(now));
      render(base({ state: "noGeo", summary, nowcast }));
      return;
    }
    default:
      render(base({ state: "error", summary: null, nowcast: null, error: { kind: "shape" } }));
  }
}
