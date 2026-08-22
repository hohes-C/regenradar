// Bootstrap, Orte, Geolocation und Refresh-Logik. Einziger Ort mit
// Date.now()/new Date() ohne Argument.

import { fetchRadarSeries, fetchPlaceName, ApiError } from "./api.js";
import { computeNowcast } from "./nowcast.js";
import { summarize } from "./text.js";
import {
  CONFIG,
  COORD_DECIMALS,
  MIN_REFETCH_MS,
  REFRESH_MS,
  GEO_MAX_AGE_MS,
  GEO_TIMEOUT_MS,
} from "./config.js";
import { render, openPlaceForm, closePlaceForm } from "./ui.js";
import {
  loadPlaces,
  addPlace,
  removePlace,
  getActiveId,
  setActiveId,
  loadLast,
  saveLast,
  loadGeoName,
  saveGeoName,
} from "./places.js";

const round = (n) => Number(n.toFixed(COORD_DECIMALS));

const state = {
  places: [],
  activeId: "geo",
  editing: false,
  loading: false,
  timer: null,
  render: null, // { summary, nowcast } zuletzt gezeigt
  geoName: null, // { key, name } aufgeloester Standortname
  currentState: "loading",
};

function chips() {
  return [{ id: "geo", name: geoLabel() }, ...state.places];
}

function geoLabel() {
  return state.geoName?.name ?? "Standort";
}

function placeName(id) {
  if (id === "geo") return geoLabel();
  return state.places.find((p) => p.id === id)?.name ?? "Ort";
}

// Kartenanker unabhaengig von den (evtl. gecachten) Radardaten. Fuer gespeicherte
// Orte synchron bekannt; fuer "geo" aus dem gemerkten Standort-Key (gerundet).
// Faellt auf die coords der aktuellen RadarSeries zurueck.
function activeCoords() {
  if (state.activeId === "geo") {
    const key = state.geoName?.key;
    if (typeof key === "string") {
      const [lat, lon] = key.split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  } else {
    const p = state.places.find((x) => x.id === state.activeId);
    if (p) return { lat: p.lat, lon: p.lon };
  }
  return state.render?.nowcast?.coords ?? null;
}

function visualState(nowcast) {
  if (nowcast.coverage === "none") return "noCoverage";
  if (nowcast.freshness === "veryStale") return "veryStale";
  if (nowcast.freshness === "stale") return "stale";
  return "ok";
}

// Zentrale Render-Schleuse: merkt sich den logischen Zustand, damit ein spaeter
// aufgeloester Ortsname das Label aktualisieren kann, ohne den Zustand zu verlieren.
function paint(view) {
  state.currentState = view.state;
  render(view);
}

function baseView(extra) {
  return {
    place: { name: placeName(state.activeId) },
    places: chips(),
    activePlaceId: state.activeId,
    editing: state.editing,
    summary: state.render?.summary ?? null,
    nowcast: state.render?.nowcast ?? null,
    coords: activeCoords(),
    ...extra,
  };
}

function renderResult(series, now) {
  const nowcast = computeNowcast(series, now, CONFIG);
  const summary = summarize(nowcast);
  state.render = { summary, nowcast };
  paint(baseView({ state: visualState(nowcast), summary, nowcast }));
}

function getGeo() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation nicht verfügbar"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, maximumAge: GEO_MAX_AGE_MS, timeout: GEO_TIMEOUT_MS }
    );
  });
}

// Ortsname des automatischen Standorts nachladen (dekorativ). Aktualisiert das
// Label, sobald der naechste DWD-Stationsname vorliegt.
async function resolveGeoName(coords) {
  const key = `${round(coords.lat)},${round(coords.lon)}`;
  if (state.geoName?.key === key) return;
  try {
    const name = await fetchPlaceName({ lat: round(coords.lat), lon: round(coords.lon) });
    if (name) {
      state.geoName = { key, name };
      saveGeoName(state.geoName);
      if (state.activeId === "geo") paint(baseView({ state: state.currentState }));
    }
  } catch {
    /* Ortsname ist dekorativ, Fehler ignorieren */
  }
}

async function load(force = false) {
  if (state.loading) return;
  const id = state.activeId;

  const cached = loadLast(id);
  if (!force && cached && Date.now() - cached.fetchedAt.getTime() < MIN_REFETCH_MS) {
    return; // frisch genug, kein Netz
  }

  state.loading = true;
  try {
    let coords;
    if (id === "geo") {
      try {
        coords = await getGeo();
      } catch {
        handleNoGeo();
        return;
      }
    } else {
      const p = state.places.find((x) => x.id === id);
      if (!p) return;
      coords = { lat: p.lat, lon: p.lon };
    }

    if (id === "geo") resolveGeoName(coords);
    paint(baseView({ state: "loading" }));
    const now = new Date();
    const series = await fetchRadarSeries({ lat: round(coords.lat), lon: round(coords.lon), now });
    saveLast(id, series);
    renderResult(series, now);
  } catch (err) {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const kind = err instanceof ApiError ? err.kind : "network";
    paint(baseView({ state: offline ? "offline" : "error", error: { kind } }));
  } finally {
    state.loading = false;
  }
}

function handleNoGeo() {
  paint(baseView({ state: "noGeo" }));
  const fallback = state.places[0];
  if (fallback) {
    // Nach Zuruecksetzen des loading-Flags auf gespeicherten Ort wechseln.
    setTimeout(() => activate(fallback.id), 0);
  }
}

function activate(id) {
  state.activeId = id;
  setActiveId(id);
  state.editing = false;
  closePlaceForm();

  const cached = loadLast(id);
  if (cached) renderResult(cached, cached.fetchedAt);
  else {
    state.render = null;
    paint(baseView({ state: "loading" }));
  }
  load(false);
}

function startPolling() {
  if (state.timer) return;
  state.timer = setInterval(() => load(false), REFRESH_MS);
}

function stopPolling() {
  clearInterval(state.timer);
  state.timer = null;
}

function onAddSubmit({ name, lat, lon, useGeo }) {
  const finish = (coords) => {
    const place = addPlace({ name, lat: coords.lat, lon: coords.lon });
    state.places = loadPlaces();
    closePlaceForm();
    activate(place.id);
  };
  if (useGeo) {
    getGeo()
      .then(finish)
      .catch(() => {
        paint(baseView({ state: "noGeo" }));
      });
  } else {
    finish({ lat, lon });
  }
}

function wireEvents() {
  document.getElementById("refresh").addEventListener("click", () => load(true));
  document.getElementById("retry").addEventListener("click", () => load(true));
  window.addEventListener("online", () => load(false));

  document.getElementById("places").addEventListener("click", (e) => {
    const target = e.target.closest("[data-id], [data-action], [data-del]");
    if (!target) return;
    if (target.dataset.del) {
      removePlace(target.dataset.del);
      state.places = loadPlaces();
      if (state.activeId === target.dataset.del) {
        activate("geo");
      } else {
        paint(baseView({ state: state.render ? visualState(state.render.nowcast) : "loading" }));
      }
      return;
    }
    const action = target.dataset.action;
    if (action === "add") {
      openPlaceForm({ onSubmit: onAddSubmit, onCancel: closePlaceForm });
      return;
    }
    if (action === "edit") {
      state.editing = !state.editing;
      paint(baseView({ state: state.render ? visualState(state.render.nowcast) : "loading" }));
      return;
    }
    if (target.dataset.id && target.dataset.id !== state.activeId) {
      activate(target.dataset.id);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPolling();
      load(false);
    } else {
      stopPolling();
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {
      /* Registrierung fehlgeschlagen: App laeuft ohne Offline-Shell weiter */
    });
  });
}

async function boot() {
  registerServiceWorker();
  const params = new URLSearchParams(location.search);
  const debugState = params.get("state");
  if (debugState) {
    const { renderDebug } = await import("./debug.js");
    renderDebug(debugState);
    return;
  }

  state.geoName = loadGeoName();
  state.places = loadPlaces();
  state.activeId = getActiveId();
  if (state.activeId !== "geo" && !state.places.find((p) => p.id === state.activeId)) {
    state.activeId = "geo";
  }

  wireEvents();
  activate(state.activeId);
  if (document.visibilityState === "visible") startPolling();
}

boot();
