// Rendering und DOM-Aktualisierung. Kein Netz, keine Zeitlogik. Bekommt ein
// fertiges View-Objekt und schreibt es in das Skelett aus index.html.

import { fmtRate, hhmm, categoryLabel, fmtTemp } from "./text.js";
import { levelLabel } from "./alerts.js";
import { HORIZON_MIN, FRAME_MIN, PAST_MIN, MMH_PER_UNIT, CONFIG } from "./config.js";
import { categorize } from "./nowcast.js";

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

function barReadout(frame) {
  const label = hhmm(frame.validTime);
  if (frame.noData) return `${label} · keine Daten`;
  if (!frame.isRain) return `${label} · trocken`;
  return `${label} · ${cap(categoryLabel(frame.category))} ${fmtRate(frame.maxMmh)} mm/h`;
}

function makeBar(frame, past) {
  const div = document.createElement("div");
  div.className = "bar";
  div._frame = frame;
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
  viewNowcast = nowcast;
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
  if (bar._frame) renderRadar(bar._frame, false);
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
    renderRadarCurrent();
  };
  tl.addEventListener("pointerup", end);
  tl.addEventListener("pointercancel", end);
  tl.addEventListener("pointerleave", (ev) => {
    if (ev.pointerType === "mouse") end();
  });
}

// Regen-Radar: farbige Niederschlagszellen aus dem DWD-Raster ueber einem
// OpenStreetMap-Kachelhintergrund, Standort in der Mitte. Beim Scrubben der
// Zeitleiste zeigt die Karte den jeweiligen Frame, sonst den aktuellen.
let viewNowcast = null;
let mapCoords = null;
let radarFrame = null;
let radarObserver = null;

function cssColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (n) => s.getPropertyValue(n).trim();
  return {
    light: get("--cat-light"),
    moderate: get("--cat-moderate"),
    strong: get("--cat-strong"),
    extreme: get("--cat-extreme"),
    text: get("--text"),
    surface: get("--map-halo"),
  };
}

// Geometrie des Rasters auf der Zeichenflaeche. Zellen bleiben quadratisch
// (1 Zelle = 1 km), das Raster fuellt den Kasten formatfuellend und wird am
// Standort ausgerichtet, der dadurch immer exakt in der Mitte sitzt.
function gridGeom(w, h, rows, cols, center) {
  const cell = Math.max(w / cols, h / rows);
  return {
    cell,
    ox: w / 2 - (center.col + 0.5) * cell,
    oy: h / 2 - (center.row + 0.5) * cell,
  };
}

function drawRadar(canvas, grid, center) {
  const ctx = canvas.getContext("2d");
  const rows = Array.isArray(grid) ? grid.length : 0;
  const cols = rows && Array.isArray(grid[0]) ? grid[0].length : 0;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || w;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!rows || !cols) return;

  const { cell, ox, oy } = gridGeom(w, h, rows, cols, center);
  const col = cssColors();
  const colorFor = (cat) =>
    cat === "light" ? col.light : cat === "moderate" ? col.moderate : cat === "strong" ? col.strong : cat === "extreme" ? col.extreme : null;

  ctx.globalAlpha = 0.85;
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    const y = oy + r * cell;
    if (y + cell < 0 || y > h) continue;
    for (let c = 0; c < cols; c++) {
      const x = ox + c * cell;
      if (x + cell < 0 || x > w) continue;
      const v = row[c];
      if (v === null || v === undefined) {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = "#808080";
        ctx.fillRect(x, y, cell + 0.6, cell + 0.6);
        ctx.globalAlpha = 0.85;
        continue;
      }
      const mmh = v * MMH_PER_UNIT;
      if (mmh < CONFIG.RAIN_MIN_MMH) continue; // trocken: transparent
      const color = colorFor(categorize(mmh, CONFIG));
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, cell + 0.6, cell + 0.6);
    }
  }
  ctx.globalAlpha = 1;

  // Reichweitenring und Standortmarke, immer in der Mitte.
  const cx = w / 2;
  const cy = h / 2;
  ctx.strokeStyle = "rgba(127,127,127,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(w, h) * 0.25, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.stroke();

  // Metrischer Maßstab. DWD RV ist ein 1-km-Raster, also 1 Zelle = 1 km und
  // `cell` sind exakt die Pixel pro Kilometer. Kein Projektionsfehler.
  drawScaleBar(ctx, w, h, cell, col);
}

function drawScaleBar(ctx, w, h, pxPerKm, col) {
  // Zielbreite ~28 % der Karte, auf runde Kilometer gebracht.
  const targetKm = (w * 0.28) / pxPerKm;
  const steps = [1, 2, 5, 10, 20, 50];
  let km = steps[0];
  for (const s of steps) if (s <= targetKm) km = s;
  const barPx = km * pxPerKm;
  const pad = 10;
  const x0 = pad;
  const x1 = pad + barPx;
  const y = h - pad;
  const cap = 5; // Höhe der Endmarken
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.moveTo(x0, y - cap);
    ctx.lineTo(x0, y);
    ctx.moveTo(x1, y - cap);
    ctx.lineTo(x1, y);
  };
  ctx.save();
  ctx.lineCap = "butt";
  // Halo in Flächenfarbe für Kontrast über hellen wie dunklen Zellen.
  ctx.strokeStyle = col.surface;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 4;
  path();
  ctx.stroke();
  // Balken in Textfarbe.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = col.text;
  ctx.lineWidth = 1.5;
  path();
  ctx.stroke();
  // Beschriftung mit gleichem Halo.
  const label = km + " km";
  ctx.font = "600 11px system-ui, -apple-system, sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = col.surface;
  ctx.globalAlpha = 0.9;
  ctx.strokeText(label, x0, y - cap - 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = col.text;
  ctx.fillText(label, x0, y - cap - 2);
  ctx.restore();
}

// OpenStreetMap-Kachelhintergrund hinter dem Radar. Web-Mercator, an der
// Marker-Koordinate verankert und auf die km/px-Skala der Karte gebracht
// (1 Rasterzelle = 1 km). Kachelnordung ~ Rasternordung; der DWD-Grid ist
// leicht rotiert, ueber 40 km vernachlaessigbar. Attribution steht im Markup.
// Der Ausschnitt geht an tile.openstreetmap.org (Fremd-Request, bewusst).
const TILE = 256;
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
let mapToken = 0;
let mapKey = null;

function lonToWorld(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

function latToWorld(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function renderMapBackground(grid) {
  const canvas = el("radar-bg");
  if (!canvas || !viewNowcast) return;
  const ctx = canvas.getContext("2d");
  const coords = mapCoords ?? viewNowcast.coords;
  const center = viewNowcast.center;
  const rows = Array.isArray(grid) ? grid.length : 0;
  const cols = rows && Array.isArray(grid[0]) ? grid[0].length : 0;
  const w = canvas.clientWidth || 0;
  const h = canvas.clientHeight || 0;
  if (!coords || !center || !rows || !cols || !w || !h) {
    mapKey = null;
    if (w && h) {
      const dpr0 = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr0);
      canvas.height = Math.round(h * dpr0);
    }
    return; // ohne Koordinaten (z. B. Debug) kein Hintergrund
  }

  const dpr = window.devicePixelRatio || 1;
  const { cell } = gridGeom(w, h, rows, cols, center); // Pixel pro Kilometer
  const mCanvasX = w / 2; // Standort sitzt in der Mitte der Flaeche
  const mCanvasY = h / 2;
  const mPerPx = 1000 / cell; // Meter pro Canvas-Pixel
  const latRad = (coords.lat * Math.PI) / 180;
  const worldMPerPx = 156543.03392 * Math.cos(latRad); // bei Zoom 0
  const z = Math.max(3, Math.min(19, Math.round(Math.log2(worldMPerPx / mPerPx))));
  const tileMPerPx = worldMPerPx / 2 ** z;
  const s = tileMPerPx / mPerPx; // Canvas-Pixel pro Weltpixel

  const key = `${z}|${coords.lat},${coords.lon}|${cols}x${rows}|${w}x${h}@${dpr}`;
  if (key === mapKey) return; // gleicher Ausschnitt, kein Neuladen
  mapKey = key;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const wx = lonToWorld(coords.lon, z) * TILE;
  const wy = latToWorld(coords.lat, z) * TILE;
  const toCanvas = (px, anchorPx, anchorCanvas) => anchorCanvas + (px - anchorPx) * s;
  const n = 2 ** z;
  const txMin = Math.max(0, Math.floor((wx + (0 - mCanvasX) / s) / TILE));
  const txMax = Math.min(n - 1, Math.floor((wx + (w - mCanvasX) / s) / TILE));
  const tyMin = Math.max(0, Math.floor((wy + (0 - mCanvasY) / s) / TILE));
  const tyMax = Math.min(n - 1, Math.floor((wy + (h - mCanvasY) / s) / TILE));

  const token = ++mapToken;
  const size = TILE * s + 0.5; // leichtes Uebermass gegen Haarlinien
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const dx = toCanvas(tx * TILE, wx, mCanvasX);
      const dy = toCanvas(ty * TILE, wy, mCanvasY);
      const img = new Image();
      img.onload = () => {
        if (token !== mapToken) return; // veralteter Ausschnitt
        ctx.drawImage(img, dx, dy, size, size);
      };
      img.onerror = () => {};
      img.src = tileUrl(z, tx, ty);
    }
  }
}

function renderRadar(frame, isNow) {
  const canvas = el("radar");
  if (!canvas || !frame || !viewNowcast) return;
  radarFrame = { frame, isNow };
  drawRadar(canvas, frame.grid, viewNowcast.center);
  renderMapBackground(frame.grid);
  const badge = el("radar-time");
  if (badge) badge.textContent = isNow ? "jetzt" : hhmm(frame.validTime);
  ensureRadarObserver(canvas);
}

function renderRadarCurrent() {
  if (!viewNowcast) return;
  const frame = viewNowcast.current ?? viewNowcast.forecast[0] ?? null;
  if (frame) renderRadar(frame, true);
}

function ensureRadarObserver(canvas) {
  if (radarObserver || typeof ResizeObserver === "undefined") return;
  radarObserver = new ResizeObserver(() => {
    if (radarFrame) {
      drawRadar(canvas, radarFrame.frame.grid, viewNowcast.center);
      renderMapBackground(radarFrame.frame.grid);
    }
  });
  radarObserver.observe(canvas);
}

function renderLegend() {
  const leg = el("radar-legend");
  if (!leg || leg.dataset.built) return;
  const items = [
    ["light", "leicht"],
    ["moderate", "mäßig"],
    ["strong", "stark"],
    ["extreme", "sehr stark"],
  ];
  for (const [catKey, label] of items) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const sw = document.createElement("i");
    sw.className = "legend-swatch cat-" + catKey;
    item.append(sw, document.createTextNode(label));
    leg.append(item);
  }
  leg.dataset.built = "1";
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
  document.body.append(form);
  form.name.focus();
}

export function closePlaceForm() {
  document.getElementById("place-form")?.remove();
}

// Wettersymbol im Hero. Drei Zustaende, gezeichnet statt als Schriftzeichen,
// damit es auf jedem Geraet gleich aussieht.
const HERO_SVG = {
  dry: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="30" r="13" fill="#ffd166" />
    <g stroke="#ffd166" stroke-width="3.4" stroke-linecap="round">
      <path d="M32 7v6M32 47v6M9 30h6M49 30h6M15.8 13.8l4.2 4.2M44 42l4.2 4.2M48.2 13.8 44 18M20 42l-4.2 4.2" />
    </g></svg>`,
  soon: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 42a10 10 0 0 1 .8-19.9 14 14 0 0 1 26.3 3.1A8.9 8.9 0 0 1 44 42H18Z" fill="#ffffff" />
    <g stroke="#7fe1ff" stroke-width="3.6" stroke-linecap="round">
      <path d="M25 48l-2.4 6M39 48l-2.4 6" />
    </g></svg>`,
  rain: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M18 40a10 10 0 0 1 .8-19.9 14 14 0 0 1 26.3 3.1A8.9 8.9 0 0 1 44 40H18Z" fill="#ffffff" />
    <g stroke="#7fe1ff" stroke-width="3.6" stroke-linecap="round">
      <path d="M22 46l-3 8M31 46l-3 8M40 46l-3 8M49 46l-3 8" />
    </g></svg>`,
};

function renderHeroIcon(kind) {
  const box = el("hero-icon");
  if (!box || box.dataset.kind === kind) return;
  box.dataset.kind = kind;
  box.innerHTML = HERO_SVG[kind] ?? HERO_SVG.dry;
}

/**
 * @param {{
 *   state: string,
 *   place?: {name: string},
 *   summary?: {title: string, icon: string, headline: string, detail: string|null, status: string}|null,
 *   nowcast?: object|null,
 *   error?: {kind: string, message?: string}|null,
 *   places?: {id: string, name: string}[],
 *   activePlaceId?: string,
 *   editing?: boolean,
 *   placesOpen?: boolean,
 *   temperature?: number|null,
 *   fetchedAt?: Date|null,
 * }} view
 */
export function render(view) {
  document.body.dataset.state = view.state;

  el("place-name").textContent = view.place?.name ?? "Aktueller Standort";
  const temp = el("temp");
  temp.hidden = typeof view.temperature !== "number";
  temp.textContent = temp.hidden ? "" : fmtTemp(view.temperature);

  const summary = view.summary;
  el("title").textContent = summary?.title ?? (view.state === "loading" ? "Wird geladen" : "");
  renderHeroIcon(summary?.icon ?? "dry");
  // Der ausfuehrliche Satz steht als Erlaeuterung in der Vorhersage-Karte.
  const detail = [summary?.headline, summary?.detail].filter(Boolean).join(" ");
  el("detail").textContent = detail;
  el("status").textContent = summary?.status ?? "";
  // Zeitpunkt des letzten erfolgreichen Abrufs. Macht sichtbar, dass der
  // Aktualisieren-Knopf gewirkt hat, auch wenn der DWD-Lauf derselbe bleibt.
  el("checked").textContent = view.fetchedAt ? `abgerufen ${hhmm(view.fetchedAt)}` : "";

  const banner = el("banner");
  if (["error", "offline", "noGeo"].includes(view.state)) {
    banner.hidden = false;
    const kind = view.state === "offline" ? "offline" : view.state === "noGeo" ? "noGeo" : view.error?.kind;
    el("banner-text").textContent = view.error?.message ?? ERR_TEXT[kind] ?? "Ein Fehler ist aufgetreten.";
    el("retry").hidden = view.state === "noGeo";
  } else {
    banner.hidden = true;
  }

  mapCoords = view.coords ?? null;
  if (view.nowcast) {
    renderTimeline(view.nowcast);
    renderLegend();
    renderRadarCurrent();
  }

  if (view.places) renderPlaces(view.places, view.activePlaceId, view.editing);
  const nav = el("places");
  nav.hidden = !view.placesOpen;
  el("places-btn").setAttribute("aria-pressed", view.placesOpen ? "true" : "false");
}

// Reiter umschalten. Der body-Zustand entscheidet, welche Ansicht sichtbar ist.
export function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const btn of document.querySelectorAll(".tab")) {
    if (btn.dataset.tab === tab) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** Zaehler an der Reiterleiste. 0 blendet ihn aus. */
export function setAlertBadge(count) {
  const b = el("tab-badge");
  if (!b) return;
  b.hidden = !count;
  b.textContent = count > 9 ? "9+" : String(count ?? 0);
}

// Warnungen: eine Karte je Ereignisart, darin eine Zeile je Warnung mit der
// amtlichen Warnstufe als farbigem Feld. Zeilen lassen sich aufklappen.
function alertWhen(a) {
  const from = a.onset ? hhmm(a.onset) : null;
  const to = a.expires ? hhmm(a.expires) : null;
  if (from && to) return `${from} bis ${to}`;
  if (from) return `ab ${from}`;
  if (to) return `bis ${to}`;
  return "";
}

function alertRow(a) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "alert-row";
  row.setAttribute("aria-expanded", "false");

  const lvl = document.createElement("span");
  lvl.className = "lvl lvl-" + a.level;
  lvl.textContent = String(a.level);

  const body = document.createElement("div");
  body.className = "alert-body";
  const line = document.createElement("div");
  line.className = "alert-line";
  line.textContent = a.description || a.headline || levelLabel(a.level);
  body.append(line);

  const when = alertWhen(a);
  if (when) {
    const w = document.createElement("span");
    w.className = "alert-when";
    w.textContent = `${levelLabel(a.level)} · ${when}`;
    body.append(w);
  }

  const extra = [a.headline, a.instruction].filter(Boolean);
  if (extra.length) {
    const more = document.createElement("div");
    more.className = "alert-more";
    for (const t of extra) {
      const p = document.createElement("p");
      p.textContent = t;
      more.append(p);
    }
    body.append(more);
    row.addEventListener("click", () => {
      row.setAttribute("aria-expanded", row.getAttribute("aria-expanded") === "true" ? "false" : "true");
    });
  } else {
    row.disabled = true;
  }

  row.append(lvl, body);
  return row;
}

// Symbol je Ereignisart. Der DWD-Ereignisname ist der verlaesslichste Anker,
// die Codes sind zahlreich und aendern sich. Ohne Treffer bleibt es beim Dreieck.
const EVENT_ICONS = [
  [/GEWITTER|BLITZ/, "i-bolt"],
  [/BÖEN|STURM|ORKAN|WIND/, "i-wind"],
  [/FROST|SCHNEE|GLÄTTE|GLATTEIS|KÄLTE/, "i-snow"],
  [/REGEN|NIEDERSCHLAG|TAUWETTER/, "i-drop"],
  [/HITZE|UV/, "i-heat"],
  [/NEBEL/, "i-fog"],
];

function eventIcon(event) {
  for (const [re, id] of EVENT_ICONS) if (re.test(event)) return id;
  return "i-warn";
}

function alertCard(group) {
  const card = document.createElement("section");
  card.className = "card";
  const head = document.createElement("h2");
  head.className = "card-head";
  head.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" style="color:var(--lvl-${group.level})"><use href="#${eventIcon(group.event)}" /></svg>`;
  head.append(document.createTextNode(group.event));
  card.append(head);
  for (const a of group.alerts) card.append(alertRow(a));
  return card;
}

function emptyCard(icon, label, text) {
  const card = document.createElement("section");
  card.className = "card";
  const head = document.createElement("h2");
  head.className = "card-head";
  head.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${icon}" /></svg>`;
  head.append(document.createTextNode(label));
  const body = document.createElement("div");
  body.className = "alert-empty";
  const lvl = document.createElement("span");
  lvl.className = "lvl lvl-0";
  lvl.textContent = "0";
  body.append(lvl, document.createTextNode(text));
  card.append(head, body);
  return card;
}

/**
 * @param {{
 *   state: string,
 *   place?: {name: string},
 *   alerts?: {groups: object[], count: number, location: object|null, fetchedAt: Date}|null,
 *   error?: {kind: string}|null,
 * }} view
 */
export function renderAlerts(view) {
  const box = el("alerts-scroll");
  if (!box) return;

  const cell = view.alerts?.location;
  const place = view.place?.name ?? "Standort";
  el("alerts-place").textContent = cell?.name ? `${place} · Warnzelle ${cell.name}` : place;
  // Der volle Warnzellenname als Titel, falls die Kurzform nicht eindeutig ist.
  el("alerts-place").title = cell?.fullName ?? "";

  box.replaceChildren();

  if (view.state === "loading" && !view.alerts) {
    box.append(emptyCard("i-clock", "Status", "wird geladen"));
    return;
  }
  if (["error", "offline"].includes(view.state) && !view.alerts) {
    const kind = view.state === "offline" ? "offline" : view.error?.kind;
    box.append(emptyCard("i-warn", "Status", ERR_TEXT[kind] ?? "Warnungen nicht abrufbar."));
    return;
  }

  const data = view.alerts;
  if (!data) return;

  if (data.groups.length === 0) {
    box.append(emptyCard("i-check", "Entwarnung", "keine amtlichen Warnungen"));
  } else {
    for (const g of data.groups) box.append(alertCard(g));
  }

  const foot = document.createElement("p");
  foot.className = "alerts-foot";
  foot.textContent = `Amtliche Warnungen des Deutschen Wetterdienstes, abgerufen ${hhmm(
    data.fetchedAt
  )}. Warnstufen 1 bis 4 nach dem DWD-Warnkonzept.`;
  box.append(foot);
}

export { renderPlaces };
