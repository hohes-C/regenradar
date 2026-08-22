import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchRadarSeries, ApiError } from "../src/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "fixtures", "raw-sample.json"), "utf8"));

// Erwartungen aus der Fixture ableiten, damit der Test nicht von einem
// bestimmten Ort abhaengt.
const parseRun = (s) => new Date(s.slice(s.lastIndexOf("::") + 2));
const RUN_TIME = raw.radar.map((r) => parseRun(r.source)).reduce((a, b) => (b > a ? b : a));
const UNIQUE_TS = new Set(raw.radar.map((r) => r.timestamp));
const CENTER = { row: Math.round(raw.latlon_position.y), col: Math.round(raw.latlon_position.x) };
const NOW = new Date(RUN_TIME.getTime() + 5 * 60_000);
const COORDS = { lat: 52.52, lon: 13.405 };

// Baut ein fetchImpl, das eine feste Antwort liefert.
function mockFetch({ ok = true, status = 200, body = "", throwErr = null } = {}) {
  return async () => {
    if (throwErr) throw throwErr;
    return {
      ok,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
}

test("Fixture wird korrekt in RadarSeries ueberfuehrt", async () => {
  const series = await fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body: raw }) });

  assert.equal(series.frames.length, UNIQUE_TS.size); // keine Duplikate
  for (let i = 1; i < series.frames.length; i++) {
    assert.ok(series.frames[i - 1].validTime.getTime() < series.frames[i].validTime.getTime());
  }
  assert.deepEqual(series.center, CENTER); // aus latlon_position gerundet
  assert.deepEqual(series.coords, COORDS); // Request-Koordinaten als Marker-Anker
  assert.deepEqual(series.runTime, RUN_TIME); // groesster source-Zeitstempel
  assert.equal(series.frames[0].isForecast, false); // erster Record <= Lauf
  assert.equal(series.frames.at(-1).isForecast, true); // letzter Record > Lauf
  assert.equal(series.frames[0].grid.length, 5);
  assert.equal(series.frames[0].grid[0].length, 5);
});

test("negative Werte werden zu null", async () => {
  const body = structuredClone(raw);
  body.radar = [body.radar[0]];
  body.radar[0].precipitation_5[0][0] = -1;
  body.radar[0].precipitation_5[1][1] = null;
  const series = await fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body }) });
  assert.equal(series.frames[0].grid[0][0], null);
  assert.equal(series.frames[0].grid[1][1], null);
});

test("Records mit precipitation_5 null werden uebersprungen", async () => {
  const body = structuredClone(raw);
  body.radar[0].precipitation_5 = null;
  const series = await fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body }) });
  assert.equal(series.frames.length, UNIQUE_TS.size - 1);
});

test("Duplikate nach validTime: letzter gewinnt", async () => {
  const body = structuredClone(raw);
  const dup = structuredClone(body.radar[0]);
  dup.precipitation_5 = dup.precipitation_5.map((r) => r.map(() => 99));
  body.radar.push(dup); // gleicher timestamp wie radar[0]
  const series = await fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body }) });
  assert.equal(series.frames.length, UNIQUE_TS.size);
  const frame = series.frames.find(
    (f) => f.validTime.getTime() === new Date(raw.radar[0].timestamp).getTime()
  );
  assert.equal(frame.grid[CENTER.row][CENTER.col], 99); // Wert aus dem spaeteren Record
});

test("Fehler: timeout", async () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  await assert.rejects(
    fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ throwErr: abort }) }),
    (e) => e instanceof ApiError && e.kind === "timeout"
  );
});

test("Fehler: network", async () => {
  await assert.rejects(
    fetchRadarSeries({
      ...COORDS,
      now: NOW,
      fetchImpl: mockFetch({ throwErr: new TypeError("failed to fetch") }),
    }),
    (e) => e instanceof ApiError && e.kind === "network"
  );
});

test("Fehler: http 500", async () => {
  await assert.rejects(
    fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ ok: false, status: 500 }) }),
    (e) => e instanceof ApiError && e.kind === "http" && e.status === 500
  );
});

test("Fehler: empty (leeres radar-Array)", async () => {
  await assert.rejects(
    fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body: { radar: [] } }) }),
    (e) => e instanceof ApiError && e.kind === "empty"
  );
});

test("Fehler: shape (Ausschnitt zu klein)", async () => {
  const body = {
    radar: [
      {
        timestamp: "2026-08-22T10:00:00+00:00",
        source: "X::RV::2026-08-22T10:00:00+00:00",
        precipitation_5: [[0, 0], [0, 0]],
      },
    ],
    latlon_position: { x: 1, y: 1 },
  };
  await assert.rejects(
    fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body }) }),
    (e) => e instanceof ApiError && e.kind === "shape"
  );
});

test("Fehler: shape (ungueltiges JSON)", async () => {
  await assert.rejects(
    fetchRadarSeries({ ...COORDS, now: NOW, fetchImpl: mockFetch({ body: "{nicht json" }) }),
    (e) => e instanceof ApiError && e.kind === "shape"
  );
});
