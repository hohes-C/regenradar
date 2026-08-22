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

function barReadout(frame) {
  const label = hhmm(frame.validTime);
  if (frame.noData) return `${label} · keine Daten`;
  if (!frame.isRain) return `${label} · trocken`;
  return `${label} · ${cap(categoryLabel(frame.category))} ${fmtRate(frame.maxMmh)} mm/h`;
}

function makeBar(frame, past) {
  const div = document.createElement("div");
  div.className = "bar";
  if (past) div.classList.add("past");
  div.dataset.readout = barReadout(frame);
  div.title = div.dataset.readout;
  if (frame.noData) {
    div.classList.add("nodata");
    div.style.height = "100%";
    return div;
  }
  div.classList.add("cat-" + frame.category);
  if (frame.uncertain) div.classList.add("uncertain");
  const capped = Math.min(frame.rateMmh, 10);
  const pct = frame.isRain ? Math.max(10, (capped / 10) * 100) : 6;
  div.style.height = pct + "%";
  return div;
}

function group(cls) {
  const g = document.createElement("div");
  g.className = "bar-group" + (cls ? " " + cls : "");
  return g;
}

function renderTimeline(nowcast) {
  const tl = el("timeline");
  hideScrub();
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

  observeTicks(nowcast.now, forecastGroup);
  wireScrub();
}

// Ticks werden bei jeder Groessenaenderung der Vorhersage-Region neu gesetzt,
// damit spaeter Reflow (z. B. Scrollbar, Schriftwechsel) sie nicht aus dem Kasten
// schiebt. Positionen sind zusaetzlich auf die Kastenbreite geclampt.
let ticksObserver = null;
let ticksState = null;

function observeTicks(now, forecastGroup) {
  ticksState = { now, forecastGroup };
  positionTicks(now, forecastGroup);
  if (typeof ResizeObserver === "undefined") return;
  if (!ticksObserver) {
    ticksObserver = new ResizeObserver(() => {
      if (ticksState) positionTicks(ticksState.now, ticksState.forecastGroup);
    });
  } else {
    ticksObserver.disconnect();
  }
  ticksObserver.observe(forecastGroup);
}

function positionTicks(now, forecastGroup) {
  const ticks = el("ticks");
  ticks.replaceChildren();

  const ticksRect = ticks.getBoundingClientRect();
  const maxW = ticks.clientWidth || 1;
  const fgRect = forecastGroup.getBoundingClientRect();
  const left = fgRect.left - ticksRect.left;
  const width = fgRect.width || 1;
  const clamp = (v) => Math.max(0, Math.min(v, maxW));

  const addTick = (label, offsetPx, { isNow = false, transform = "translateX(-50%)" } = {}) => {
    const t = document.createElement("span");
    t.className = "tick" + (isNow ? " now" : "");
    t.textContent = label;
    t.style.left = clamp(offsetPx) + "px";
    t.style.transform = transform;
    ticks.append(t);
  };

  addTick("jetzt", left, { isNow: true, transform: "none" });
  for (const m of [30, 60, 90, HORIZON_MIN]) {
    const frac = m / HORIZON_MIN;
    const transform = m === HORIZON_MIN ? "translateX(-100%)" : "translateX(-50%)";
    addTick(hhmm(new Date(now.getTime() + m * MIN)), left + frac * width, { transform });
  }
}

// Scrubbing: Finger oder Maus ueber die Leiste zeigt Zeit und Intensitaet des
// beruehrten Frames. Elemente werden einmalig erzeugt, Listener einmalig verdrahtet.
let scrubWired = false;

function scrubEls() {
  const wrap = document.querySelector(".timeline-wrap");
  if (!wrap) return null;
  if (!wrap.querySelector(".scrub-readout")) {
    const line = document.createElement("div");
    line.className = "scrub-line";
    const readout = document.createElement("div");
    readout.className = "scrub-readout";
    wrap.append(line, readout);
  }
  return {
    wrap,
    line: wrap.querySelector(".scrub-line"),
    readout: wrap.querySelector(".scrub-readout"),
  };
}

function hideScrub() {
  const e = scrubEls();
  if (!e) return;
  e.readout.classList.remove("on");
  e.line.classList.remove("on");
}

function scrubAt(clientX) {
  const tl = el("timeline");
  const e = scrubEls();
  if (!e) return;
  const r = tl.getBoundingClientRect();
  const x = Math.max(r.left + 1, Math.min(clientX, r.right - 1));
  const bar = document.elementFromPoint(x, r.bottom - 3)?.closest?.(".bar");
  if (!bar || !tl.contains(bar)) {
    hideScrub();
    return;
  }
  const br = bar.getBoundingClientRect();
  const wr = e.wrap.getBoundingClientRect();
  e.readout.textContent = bar.dataset.readout || "";
  const half = Math.min(90, (e.readout.offsetWidth || 80) / 2);
  let cx = br.left + br.width / 2 - wr.left;
  cx = Math.max(half + 4, Math.min(cx, wr.width - half - 4));
  e.readout.style.left = cx + "px";
  e.line.style.left = br.left + br.width / 2 - wr.left + "px";
  e.line.style.top = r.top - wr.top + "px";
  e.line.style.height = r.height + "px";
  e.readout.classList.add("on");
  e.line.classList.add("on");
}

function wireScrub() {
  if (scrubWired) return;
  scrubWired = true;
  const tl = el("timeline");
  let active = false;
  tl.addEventListener("pointerdown", (ev) => {
    active = true;
    try {
      tl.setPointerCapture(ev.pointerId);
    } catch {
      /* egal */
    }
    scrubAt(ev.clientX);
  });
  tl.addEventListener("pointermove", (ev) => {
    if (active || ev.pointerType === "mouse") scrubAt(ev.clientX);
  });
  const end = () => {
    active = false;
    hideScrub();
  };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse") end();
  });
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
