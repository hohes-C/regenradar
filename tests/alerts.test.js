import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeAlerts, levelOf, levelLabel } from "../src/alerts.js";
import { ApiError } from "../src/api.js";

const alert = (over = {}) => ({
  id: 1,
  event_de: "BÖEN",
  event_code: 11,
  severity: "minor",
  headline_de: "Amtliche Warnung vor BÖEN",
  description_de: "Böen von 7 Beaufort aus Nordwest.",
  instruction_de: null,
  onset: "2026-08-23T02:27:00+00:00",
  effective: "2026-08-23T02:00:00+00:00",
  expires: null,
  ...over,
});

test("Warnstufen aus der CAP-Severity", () => {
  assert.equal(levelOf("minor"), 1);
  assert.equal(levelOf("moderate"), 2);
  assert.equal(levelOf("severe"), 3);
  assert.equal(levelOf("extreme"), 4);
  assert.equal(levelOf(undefined), 1); // unbekannt gilt als Stufe 1
  assert.equal(levelLabel(3), "Unwetterwarnung");
});

test("leere Antwort ergibt keine Gruppen", () => {
  const out = normalizeAlerts({ alerts: [], location: { name: "Berl. - Mitte", state: "Berlin" } });
  assert.equal(out.count, 0);
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.location, { name: "Berl. - Mitte", state: "Berlin" });
});

test("fehlendes alerts-Feld ist ein Formatfehler", () => {
  assert.throws(() => normalizeAlerts({}), (e) => e instanceof ApiError && e.kind === "shape");
});

test("identische Warnungen mehrerer Warnzellen werden zusammengefasst", () => {
  const out = normalizeAlerts({ alerts: [alert({ id: 1 }), alert({ id: 2 }), alert({ id: 3 })] });
  assert.equal(out.count, 1);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].alerts.length, 1);
});

test("unterschiedliche Zeitspannen bleiben getrennt", () => {
  const out = normalizeAlerts({
    alerts: [alert({ id: 1 }), alert({ id: 2, onset: "2026-08-23T09:00:00+00:00" })],
  });
  assert.equal(out.count, 2);
  assert.equal(out.groups[0].alerts.length, 1 + 1);
});

test("Gruppen nach Ereignis, Sortierung nach Warnstufe", () => {
  const out = normalizeAlerts({
    alerts: [
      alert({ id: 1, event_de: "BÖEN", severity: "minor" }),
      alert({ id: 2, event_de: "GEWITTER", event_code: 31, severity: "severe" }),
      alert({ id: 3, event_de: "GEWITTER", event_code: 31, severity: "moderate", onset: "2026-08-23T12:00:00+00:00" }),
    ],
  });
  assert.deepEqual(out.groups.map((g) => g.event), ["GEWITTER", "BÖEN"]);
  assert.equal(out.groups[0].level, 3); // hoechste Stufe der Gruppe
  assert.deepEqual(out.groups[0].alerts.map((a) => a.level), [3, 2]);
  assert.equal(out.count, 3);
});

test("Zeitstempel werden zu Date, onset faellt auf effective zurueck", () => {
  const out = normalizeAlerts({
    alerts: [alert({ onset: null, expires: "2026-08-23T13:00:00+00:00" })],
  });
  const a = out.groups[0].alerts[0];
  assert.equal(a.onset.toISOString(), "2026-08-23T02:00:00.000Z");
  assert.equal(a.expires.toISOString(), "2026-08-23T13:00:00.000Z");
});

test("fehlende Texte werden zu null, fehlendes Ereignis bekommt einen Namen", () => {
  const out = normalizeAlerts({
    alerts: [alert({ event_de: null, headline_de: null, description_de: null })],
  });
  const a = out.groups[0].alerts[0];
  assert.equal(a.event, "WARNUNG");
  assert.equal(a.headline, null);
  assert.equal(a.description, null);
});
