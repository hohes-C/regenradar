// Rendering und DOM-Aktualisierung. Kein Netz, keine Zeitlogik. Bekommt ein
// fertiges View-Objekt und schreibt es in das Skelett aus index.html.

import { fmtRate, hhmm, categoryLabel } from "./text.js";
import { RAIN_MIN_MMH, HORIZON_MIN, FRAME_MIN, PAST_MIN } from "./config.js";

const MIN = 60_000;
const el = (id) => document.getElementById(id);

const ERR_TEXT = {
  network: "Keine Verbindung zum Wetterdienst.",
  timeout: "Zeitüberschreitung bei der Anfrage.",
  http: "Der Wetterdienst antwortet gerade nicht.",
  empty: "Keine Radardaten erhalten.",
  shape: "Unerwartetes Antwortformat.",
  offline: "Offline.",
  noGeo: "Standort nicht verfügbar, zeige gespeicherten Ort.",
};

// Ampel-Stufe fuer eine Kachel.
function levelFor(category) {
  if (category === "none") return "dry";
  if (category === "light" || category === "moderate") return "warn";
  return "alert";
}

function makeBar(frame, past) {
  const div = document.createElement("div");
  div.className = "bar";
  if (past) div.classList.add("past");
  if (frame.noData) {
    div.classList.add("nodata");
    div.style.height = "100%";
    div.title = "keine Daten";
    return div;
  }
  div.classList.add("cat-" + frame.category);
  if (frame.uncertain) div.classList.add("uncertain");
  const capped = Math.min(frame.rateMmh, 10);
  const pct = frame.isRain ? Math.max(10, (capped / 10) * 100) : 6;
  div.style.height = pct + "%";
  div.title = `${hhmm(frame.validTime)} · ${fmtRate(frame.maxMmh)} mm/h`;
  return div;
}

function group(cls) {
  const g = document.createElement("div");
  g.className = "bar-group" + (cls ? " " + cls : "");
  return g;
}

function renderTimeline(nowcast) {
  const tl = el("timeline");
  tl.replaceChildren();

  const pastCount = Math.round(PAST_MIN / FRAME_MIN);
  const past = nowcast.past.slice(-pastCount);
  let forecastGroup;

  if (past.length) {
    const g = group();
    for (const f of past) g.append(makeBar(f, true));
    tl.append(g);
    const div = document.createElement("div");
    div.className = "divider";
    tl.append(div);
  }

  forecastGroup = group("forecast");
  for (const f of nowcast.forecast) forecastGroup.append(makeBar(f, false));
  tl.append(forecastGroup);

  positionTicks(nowcast, forecastGroup);
}

// Zeit-Ticks alle 30 Minuten, ausgerichtet an der Vorhersage-Region.
function positionTicks(nowcast, forecastGroup) {
  const ticks = el("ticks");
  ticks.replaceChildren();

  const wrapRect = ticks.getBoundingClientRect();
  const fgRect = forecastGroup.getBoundingClientRect();
  const left = fgRect.left - wrapRect.left;
  const width = fgRect.width || 1;

  const addTick = (label, offsetPx, isNow) => {
    const t = document.createElement("span");
    t.className = "tick" + (isNow ? " now" : "");
    t.textContent = label;
    t.style.left = offsetPx + "px";
    ticks.append(t);
  };

  addTick("jetzt", left, true);
  for (const m of [30, 60, 90, HORIZON_MIN]) {
    const frac = m / HORIZON_MIN;
    addTick(hhmm(new Date(nowcast.now.getTime() + m * MIN)), left + frac * width, false);
  }
}

function renderTiles(nowcast) {
  const tilesEl = el("tiles");
  const map = { m10: "m10", m20: "m20", m120: "m120" };
  for (const key of Object.keys(map)) {
    const w = nowcast.windows[key];
    const tile = tilesEl.querySelector(`[data-window="${key}"]`);
    const textEl = tile.querySelector(".tile-text");
    tile.classList.remove("cat-none", "cat-light", "cat-moderate", "cat-strong", "cat-extreme");

    if (nowcast.coverage === "none" || w.maxMmh < RAIN_MIN_MMH) {
      tile.dataset.level = "dry";
      tile.classList.add("cat-none");
      textEl.innerHTML = "trocken";
    } else {
      tile.dataset.level = levelFor(w.category);
      tile.classList.add("cat-" + w.category);
      const ab = w.firstRainAt ? ` ab ${hhmm(w.firstRainAt)}` : "";
      textEl.innerHTML = `${cap(categoryLabel(w.category))}${ab}<span class="tile-rate">${fmtRate(
        w.maxMmh
      )} mm/h</span>`;
    }
  }
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function renderPlaces(places, activeId, editing) {
  const nav = el("places");
  nav.replaceChildren();
  for (const p of places) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.id = p.id;
    if (p.id === activeId) chip.setAttribute("aria-current", "true");
    chip.append(document.createTextNode(p.name));
    if (editing && p.id !== "geo") {
      const del = document.createElement("span");
      del.className = "chip-del";
      del.dataset.del = p.id;
      del.setAttribute("role", "button");
      del.setAttribute("aria-label", `${p.name} löschen`);
      del.textContent = "×";
      chip.append(del);
    }
    nav.append(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip add";
  add.dataset.action = "add";
  add.setAttribute("aria-label", "Ort hinzufügen");
  add.textContent = "+";
  nav.append(add);

  const hasSaved = places.some((p) => p.id !== "geo");
  if (hasSaved) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "chip" + (editing ? " edit-on" : "");
    edit.dataset.action = "edit";
    edit.textContent = editing ? "fertig" : "bearbeiten";
    nav.append(edit);
  }
}

// Kleines Formular zum Anlegen eines Ortes. onSubmit bekommt {name,lat,lon}
// oder {name, useGeo:true}. Reines DOM, Logik liegt in main.js.
export function openPlaceForm({ onSubmit, onCancel }) {
  closePlaceForm();
  const nav = el("places");
  const form = document.createElement("form");
  form.className = "place-form";
  form.id = "place-form";
  form.innerHTML = `
    <input name="name" type="text" placeholder="Name" autocomplete="off" required />
    <div class="row">
      <input name="lat" type="number" step="any" inputmode="decimal" placeholder="Breite (lat)" />
      <input name="lon" type="number" step="any" inputmode="decimal" placeholder="Länge (lon)" />
    </div>
    <div class="row">
      <button type="button" data-act="geo">Aktuelle Position übernehmen</button>
    </div>
    <div class="row">
      <button type="submit" class="primary">Speichern</button>
      <button type="button" data-act="cancel">Abbrechen</button>
    </div>
  `;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const lat = parseFloat(form.lat.value);
    const lon = parseFloat(form.lon.value);
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return;
    onSubmit({ name, lat, lon });
  });
  form.querySelector('[data-act="geo"]').addEventListener("click", () => {
    const name = form.name.value.trim() || "Aktuelle Position";
    onSubmit({ name, useGeo: true });
  });
  form.querySelector('[data-act="cancel"]').addEventListener("click", () => onCancel?.());
  nav.insertAdjacentElement("afterend", form);
  form.name.focus();
}

export function closePlaceForm() {
  document.getElementById("place-form")?.remove();
}

/**
 * @param {{
 *   state: string,
 *   place?: {name: string},
 *   summary?: {headline: string, detail: string|null, status: string}|null,
 *   nowcast?: object|null,
 *   error?: {kind: string, message?: string}|null,
 *   places?: {id: string, name: string}[],
 *   activePlaceId?: string,
 *   editing?: boolean,
 * }} view
 */
export function render(view) {
  document.body.dataset.state = view.state;

  el("place-name").textContent = view.place?.name ?? "Aktueller Standort";

  const summary = view.summary;
  el("status").textContent = summary?.status ?? (view.state === "loading" ? "Wird geladen" : "");
  el("headline").textContent = summary?.headline ?? "";
  el("detail").textContent = summary?.detail ?? "";

  const banner = el("banner");
  if (["error", "offline", "noGeo"].includes(view.state)) {
    banner.hidden = false;
    const kind = view.state === "offline" ? "offline" : view.state === "noGeo" ? "noGeo" : view.error?.kind;
    el("banner-text").textContent = view.error?.message ?? ERR_TEXT[kind] ?? "Ein Fehler ist aufgetreten.";
    el("retry").hidden = view.state === "noGeo";
  } else {
    banner.hidden = true;
  }

  if (view.nowcast) {
    renderTimeline(view.nowcast);
    renderTiles(view.nowcast);
  }

  if (view.places) renderPlaces(view.places, view.activePlaceId, view.editing);
}

export { renderPlaces };
