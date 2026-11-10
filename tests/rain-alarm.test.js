import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNowcast } from "../src/nowcast.js";
import { CONFIG, PUSH_ALERT_WINDOW_MIN, PUSH_COOLDOWN_MIN } from "../src/config.js";
import { decide, upcomingRain, rainMessage } from "../push/src/rain.js";
import { buildSeries, BASE_NOW } from "./helpers.js";

const MIN = 60_000;
const OPTS = { windowMin: PUSH_ALERT_WINDOW_MIN, cooldownMin: PUSH_COOLDOWN_MIN };
const R = 50; // 6 mm/h, maessig

// Nowcast zu einem Zeitpunkt. Frame i liegt auf now + 5*i Minuten.
const nc = (values, now = BASE_NOW, opts = {}) => computeNowcast(buildSeries(values, { now, ...opts }), now, CONFIG);
const dry = (now) => nc(new Array(25).fill(0), now);
// Regen ab Frame `k` (also ab now + 5*(k-1) Minuten), sechs Frames lang.
const rainAt = (k, now) => nc([...new Array(k).fill(0), ...new Array(6).fill(R), ...new Array(25 - k - 6).fill(0)], now);

test("Regen in 20 Minuten loest aus, in 45 Minuten noch nicht", () => {
  assert.ok(upcomingRain(rainAt(5, BASE_NOW), 30).event); // Beginn +20 min
  assert.equal(upcomingRain(rainAt(10, BASE_NOW), 30).event, null); // Beginn +45 min
});

test("Unbrauchbare Daten aendern den Zustand nicht", () => {
  const none = nc(new Array(25).fill(null));
  const prev = { phase: "alerted", alertedAt: 1 };
  assert.deepEqual(decide(none, prev, OPTS), { state: prev, notify: null });
  const stale = nc(new Array(25).fill(0), BASE_NOW, { runOffsetMin: 40 });
  assert.deepEqual(decide(stale, prev, OPTS), { state: prev, notify: null });
});

test("Eine Nachricht pro Regenphase, nicht alle fuenf Minuten", () => {
  let t = BASE_NOW;
  let r = decide(rainAt(5, t), null, OPTS);
  assert.ok(r.notify, "erster Lauf mit Regen im Fenster alarmiert");
  assert.equal(r.state.phase, "alerted");

  // Fuenf Minuten spaeter, Regen noch im Anmarsch: keine zweite Nachricht.
  t = new Date(t.getTime() + 5 * MIN);
  r = decide(rainAt(4, t), r.state, OPTS);
  assert.equal(r.notify, null);

  // Es regnet: weiterhin still.
  t = new Date(t.getTime() + 20 * MIN);
  r = decide(rainAt(0, t), r.state, OPTS);
  assert.equal(r.notify, null);
  assert.equal(r.state.phase, "alerted");
});

test("Nach Trockenheit und Abkuehlzeit gibt es fuer den naechsten Regen wieder eine Nachricht", () => {
  const t0 = BASE_NOW;
  let r = decide(rainAt(5, t0), null, OPTS);
  assert.ok(r.notify);

  // Trocken und nichts im Fenster: zurueck auf "dry", Alarmzeit bleibt gemerkt.
  const t1 = new Date(t0.getTime() + 50 * MIN);
  r = decide(dry(t1), r.state, OPTS);
  assert.equal(r.state.phase, "dry");
  assert.equal(r.state.alertedAt, t0.getTime());

  // Neuer Regen, aber noch innerhalb der Abkuehlzeit: still.
  const t2 = new Date(t0.getTime() + 55 * MIN);
  r = decide(rainAt(5, t2), r.state, OPTS);
  assert.equal(r.notify, null);

  // Abkuehlzeit vorbei: alarmiert wieder.
  const t3 = new Date(t0.getTime() + PUSH_COOLDOWN_MIN * MIN);
  r = decide(rainAt(4, t3), r.state, OPTS);
  assert.ok(r.notify);
});

test("Trocken ohne Vorgeschichte bleibt still und schreibt keinen neuen Zustand", () => {
  const prev = { phase: "dry", alertedAt: null };
  const r = decide(dry(BASE_NOW), prev, OPTS);
  assert.equal(r.notify, null);
  assert.equal(r.state, prev); // gleiche Referenz: kein Schreibzugriff noetig
});

test("Text: Minuten bis Beginn, Kategorie, Dauer und Uhrzeit in der Zeitzone des Geraets", () => {
  const n = rainAt(5, BASE_NOW); // BASE_NOW ist 12:00 UTC
  const event = upcomingRain(n, 30).event;
  const msg = rainMessage(event, BASE_NOW, { place: "Nürnberg", timeZone: "Europe/Berlin" });
  assert.equal(msg.title, "Mäßiger Regen in 20 Minuten");
  assert.equal(msg.body, "Nürnberg: ab 13:20, etwa 30 Minuten."); // 12:20 UTC = 13:20 MEZ
});

test("Text: Regen jetzt oder in unter drei Minuten heisst 'Gleich'", () => {
  const n = rainAt(0, BASE_NOW);
  const event = upcomingRain(n, 30).event;
  const msg = rainMessage(event, BASE_NOW, { place: "Ort", timeZone: "Europe/Berlin" });
  assert.equal(msg.title, "Gleich mäßiger Regen");
});

test("Text: unbekannte Zeitzone faellt auf Europe/Berlin zurueck statt zu werfen", () => {
  const event = upcomingRain(rainAt(5, BASE_NOW), 30).event;
  const msg = rainMessage(event, BASE_NOW, { place: "Ort", timeZone: "Mars/Olympus" });
  assert.match(msg.body, /ab 13:20/);
});
