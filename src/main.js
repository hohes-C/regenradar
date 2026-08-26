// Bootstrap, Orte, Geolocation und Refresh-Logik. Einziger Ort mit
// Date.now()/new Date() ohne Argument.

import { fetchRadarSeries, fetchCurrentWeather, ApiError } from "./api.js";
import { computeNowcast } from "./nowcast.js";
import { summarize } from "./text.js";
import {
  CONFIG,
  COORD_DECIMALS,
  MIN_REFETCH_MS,
  REFRESH_MS,
  CLOCK_MS,
  CURRENT_MAX_AGE_MIN,
  GEO_MAX_AGE_MS,
  GEO_TIMEOUT_MS,
} from "./config.js";
import { render, renderAlerts, setTab, setAlertBadge, openPlaceForm, closePlaceForm } from "./ui.js";
import { fetchAlerts } from "./alerts.js";
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
  timer: null, // Netz-Poll
  clock: null, // Neuberechnung gegen die Uhr
  series: null, // zuletzt geladene RadarSeries des aktiven Ortes
  tab: "rain", // sichtbarer Reiter: rain | alerts
  placesOpen: false,
  alerts: null, // zuletzt geladene Warnungen des aktiven Ortes
  alertsLoading: false,
  alertsState: "loading",
  render: null, // { summary, nowcast } zuletzt gezeigt
  geoName: null, // { key, name } aufgeloester Standortname
  current: null, // { temperature, timestamp } der naechsten DWD-Station
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
    fetchedAt: state.series?.fetchedAt ?? null,
    temperature: currentTemperature(),
    placesOpen: state.placesOpen,
    ...extra,
  };
}

function renderResult(series, now) {
  state.series = series;
  const nowcast = computeNowcast(series, now, CONFIG);
  const summary = summarize(nowcast);
  state.render = { summary, nowcast };
  paint(baseView({ state: visualState(nowcast), summary, nowcast }));
}

function paintAlerts(extra = {}) {
  renderAlerts({
    state: state.alertsState,
    place: { name: placeName(state.activeId) },
    alerts: state.alerts,
    ...extra,
  });
  setAlertBadge(state.alerts?.count ?? 0);
}

// Amtliche DWD-Warnungen des aktiven Ortes. Eigener Abruf, unabhaengig vom
// Radar: ein Fehler hier darf die Regenansicht nicht stoeren und umgekehrt.
async function loadAlerts(force = false) {
  if (state.alertsLoading) return;
  const id = state.activeId;
  const fresh = state.alerts && Date.now() - state.alerts.fetchedAt.getTime() < MIN_REFETCH_MS;
  if (!force && fresh) return;

  const coords = activeCoords();
  if (!coords) return; // ohne Ort kein Abruf, kommt mit dem naechsten Radar-Lauf

  state.alertsLoading = true;
  if (!state.alerts) {
    state.alertsState = "loading";
    paintAlerts();
  }
  try {
    const data = await fetchAlerts({ lat: round(coords.lat), lon: round(coords.lon), now: new Date() });
    if (state.activeId !== id) return; // Ort wurde zwischenzeitlich gewechselt
    state.alerts = data;
    state.alertsState = "ok";
    paintAlerts();
  } catch (err) {
    if (state.activeId !== id) return;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const kind = err instanceof ApiError ? err.kind : "network";
    state.alertsState = offline ? "offline" : "error";
    paintAlerts({ error: { kind } });
  } finally {
    state.alertsLoading = false;
  }
}

// Anzeige gegen die aktuelle Uhr neu rechnen, ohne Netz. Ohne das haengen
// Zeitleiste, Ticks und "jetzt" bis zur naechsten erfolgreichen Abfrage an der
// Uhrzeit des letzten Abrufs.
function retick() {
  if (!state.series || state.loading) return;
  // Fehler- und Offline-Banner nicht durch ein reines Uhr-Update wegwischen.
  if (["error", "offline", "noGeo"].includes(state.currentState)) return;
  renderResult(state.series, new Date());
}

// `fresh` erzwingt eine neue Standortbestimmung statt einer gecachten Position.
function getGeo({ fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation nicht verfügbar"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      {
        enableHighAccuracy: false,
        maximumAge: fresh ? 0 : GEO_MAX_AGE_MS,
        timeout: GEO_TIMEOUT_MS,
      }
    );
  });
}

// Nur anzeigen, wenn die Beobachtung frisch genug ist. Die DWD-Stationen melden
// stuendlich; ein deutlich aelterer Wert waere irrefuehrend.
function currentTemperature() {
  const c = state.current;
  if (!c || c.temperature === null) return null;
  if (c.timestamp && Date.now() - c.timestamp.getTime() > CURRENT_MAX_AGE_MIN * 60000) return null;
  return c.temperature;
}

// Aktuelle Messwerte der naechsten DWD-Station nachladen: Temperatur fuer jeden
// Ort, zusaetzlich der Stationsname als Label des automatischen Standorts.
// Dekorativ, deshalb ohne eigenen Fehlerzustand.
async function resolveCurrent(coords, id) {
  const key = `${round(coords.lat)},${round(coords.lon)}`;
  const data = await fetchCurrentWeather({ lat: round(coords.lat), lon: round(coords.lon) });
  if (!data || state.activeId !== id) return;

  state.current = { temperature: data.temperature, timestamp: data.timestamp };
  if (id === "geo" && data.stationName && state.geoName?.key !== key) {
    state.geoName = { key, name: data.stationName };
    saveGeoName(state.geoName);
  }
  paint(baseView({ state: state.currentState }));
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
        coords = await getGeo({ fresh: force });
      } catch {
        handleNoGeo();
        return;
      }
    } else {
      const p = state.places.find((x) => x.id === id);
      if (!p) return;
      coords = { lat: p.lat, lon: p.lon };
    }

    resolveCurrent(coords, id);
    paint(baseView({ state: "loading" }));
    const now = new Date();
    const series = await fetchRadarSeries({ lat: round(coords.lat), lon: round(coords.lon), now });
    saveLast(id, series);
    renderResult(series, now);
    loadAlerts(force);
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
  state.placesOpen = false;
  state.current = null;
  state.alerts = null;
  state.alertsState = "loading";
  paintAlerts();
  closePlaceForm();

  const cached = loadLast(id);
  if (cached) renderResult(cached, new Date());
  else {
    state.series = null;
    state.render = null;
    paint(baseView({ state: "loading" }));
  }
  load(false);
}

function switchTab(tab) {
  if (!tab || tab === state.tab) return;
  state.tab = tab;
  state.placesOpen = false;
  closePlaceForm();
  setTab(tab);
  paint(baseView({ state: state.currentState }));
  if (tab === "alerts") loadAlerts(false);
}

function startPolling() {
  if (!state.timer) {
    state.timer = setInterval(() => {
      load(false);
      loadAlerts(false);
    }, REFRESH_MS);
  }
  if (!state.clock) state.clock = setInterval(retick, CLOCK_MS);
}

function stopPolling() {
  clearInterval(state.timer);
  clearInterval(state.clock);
  state.timer = null;
  state.clock = null;
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

// Ein Knopf fuer alles: neuer Standort, neue Radardaten, neu gerechnete Anzeige.
// Der Spinner laeuft ueber die gesamte Dauer, auch wenn zwischendurch nicht
// neu gezeichnet wird.
async function refreshAll() {
  if (state.loading) return;
  document.body.dataset.refreshing = "1";
  try {
    await Promise.all([load(true), loadAlerts(true)]);
  } finally {
    delete document.body.dataset.refreshing;
  }
}

function wireEvents() {
  document.getElementById("refresh").addEventListener("click", refreshAll);
  document.getElementById("alerts-refresh").addEventListener("click", refreshAll);
  document.getElementById("retry").addEventListener("click", refreshAll);
  window.addEventListener("online", () => {
    load(false);
    loadAlerts(false);
  });

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

  document.getElementById("places-btn").addEventListener("click", () => {
    state.placesOpen = !state.placesOpen;
    if (!state.placesOpen) closePlaceForm();
    paint(baseView({ state: state.currentState }));
  });

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
    if (target.dataset.id) {
      if (target.dataset.id === state.activeId) {
        state.placesOpen = false;
        paint(baseView({ state: state.currentState }));
      } else {
        activate(target.dataset.id);
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPolling();
      retick(); // sofort auf die aktuelle Uhrzeit, auch ohne neue Daten
      load(false);
      loadAlerts(false);
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
  setTab(state.tab);
  activate(state.activeId);
  if (document.visibilityState === "visible") startPolling();
}

boot();
