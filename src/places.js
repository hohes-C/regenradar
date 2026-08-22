// Gespeicherte Orte, aktiver Ort und das letzte Ergebnis pro Ort in
// localStorage. Reine Persistenzschicht ohne DOM und ohne Netz.

const PLACES_KEY = "regenradar.places";
const ACTIVE_KEY = "regenradar.activePlace";
const lastKey = (id) => `regenradar.last.${id}`;

const store = () => globalThis.localStorage;

function readJson(key, fallback) {
  try {
    const raw = store()?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher voll oder blockiert: still ignorieren */
  }
}

/** @returns {{id:string,name:string,lat:number,lon:number}[]} */
export function loadPlaces() {
  const arr = readJson(PLACES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function savePlaces(arr) {
  writeJson(PLACES_KEY, arr);
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Legt einen Ort an und gibt ihn inklusive id zurueck. */
export function addPlace({ name, lat, lon }) {
  const place = { id: makeId(), name, lat, lon };
  const arr = loadPlaces();
  arr.push(place);
  savePlaces(arr);
  return place;
}

export function removePlace(id) {
  savePlaces(loadPlaces().filter((p) => p.id !== id));
  try {
    store()?.removeItem(lastKey(id));
  } catch {
    /* ignore */
  }
  if (getActiveId() === id) setActiveId("geo");
}

/** Aktiver Ort: "geo" oder eine Orts-id. */
export function getActiveId() {
  try {
    return store()?.getItem(ACTIVE_KEY) || "geo";
  } catch {
    return "geo";
  }
}

export function setActiveId(id) {
  try {
    store()?.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Letztes Ergebnis als serialisierte RadarSeries. Dates werden beim Laden
 * wiederhergestellt. @returns RadarSeries|null
 */
export function loadLast(id) {
  const o = readJson(lastKey(id), null);
  if (!o || !Array.isArray(o.frames)) return null;
  return {
    fetchedAt: new Date(o.fetchedAt),
    runTime: o.runTime ? new Date(o.runTime) : null,
    center: o.center,
    frames: o.frames.map((f) => ({
      validTime: new Date(f.validTime),
      grid: f.grid,
      isForecast: f.isForecast,
    })),
  };
}

export function saveLast(id, series) {
  writeJson(lastKey(id), series);
}

// Aufgeloester Name des automatischen Standorts, gebunden an die gerundeten
// Koordinaten (key), damit bei Ortswechsel neu aufgeloest wird.
export function loadGeoName() {
  return readJson("regenradar.geoName", null);
}

export function saveGeoName(value) {
  writeJson("regenradar.geoName", value);
}
