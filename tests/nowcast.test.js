import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNowcast, categorize } from "../src/nowcast.js";
import { CONFIG } from "../src/config.js";
import { buildSeries, at, BASE_NOW } from "./helpers.js";

const now = BASE_NOW;
const nc = (values, opts) => computeNowcast(buildSeries(values, opts), now, CONFIG);

// Regenwert: 50 Einheiten -> 6 mm/h -> "moderate".
const R = 50;

test("komplett trocken: keine Ereignisse, coverage ok", () => {
  const out = nc(new Array(25).fill(0));
  assert.equal(out.events.length, 0);
  assert.equal(out.isolatedFrames.length, 0);
  assert.equal(out.coverage, "ok");
  assert.equal(out.windows.m10.category, "none");
  assert.equal(out.windows.m120.category, "none");
  assert.equal(out.windows.m120.firstRainAt, null);
  assert.equal(out.freshness, "fresh");
});

test("Regen jetzt, endet nach 35 Minuten", () => {
  const values = new Array(25).fill(0);
  for (let i = 0; i <= 7; i++) values[i] = R; // now .. now+35
  const out = nc(values);
  assert.equal(out.events.length, 1);
  const e = out.events[0];
  assert.equal(e.startsNow, true);
  assert.equal(e.openEnded, false);
  assert.deepEqual(e.end, at(35));
  assert.equal(out.current.isRain, true);
  assert.equal(out.current.category, "moderate");
});

test("trocken, Regen beginnt in 30 Minuten, Dauer 25 Minuten", () => {
  const values = new Array(25).fill(0);
  for (let i = 7; i <= 11; i++) values[i] = R; // start now+30, 5 Frames
  const out = nc(values);
  assert.equal(out.events.length, 1);
  const e = out.events[0];
  assert.equal(e.startsNow, false);
  assert.deepEqual(e.start, at(30));
  assert.equal(e.durationMin, 25);
  assert.equal(e.peakCategory, "moderate");
});

test("zwei getrennte Schauer", () => {
  const values = new Array(25).fill(0);
  for (let i = 1; i <= 3; i++) values[i] = R;
  for (let i = 9; i <= 11; i++) values[i] = R;
  const out = nc(values);
  assert.equal(out.events.length, 2);
  assert.ok(out.events[0].start.getTime() < out.events[1].start.getTime());
});

test("einzelner Regen-Frame: Ausreisser, kein Ereignis, im 10-Minuten-Fenster", () => {
  const values = new Array(25).fill(0);
  values[1] = R; // lead 0, innerhalb m10
  const out = nc(values);
  assert.equal(out.events.length, 0);
  assert.equal(out.isolatedFrames.length, 1);
  assert.equal(out.isolatedFrames[0].isolated, true);
  assert.ok(out.windows.m10.maxMmh > 0);
});

test("trockener Frame in Regenphase wird ueberbrueckt", () => {
  const values = new Array(25).fill(0);
  values[1] = R;
  values[2] = R;
  // values[3] = 0 (Luecke)
  values[4] = R;
  values[5] = R;
  const out = nc(values);
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.events[0].start, at(0)); // frame1.vt - 5 = now
  assert.deepEqual(out.events[0].end, at(25)); // frame5.vt
});

test("Regen nur im Zentrum, Nachbarn trocken: Intensitaet mindestens light", () => {
  const values = new Array(25).fill(0);
  values[1] = 500; // waere uniform "extreme", aber Nachbarn 0
  values[2] = 500;
  const out = nc(values, { neighbors: "zero" });
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].peakCategory, "light");
  assert.equal(out.forecast[0].isRain, true);
});

test("Regen nur ab +75 Minuten: uncertain, Fenster 5x5 aktiv", () => {
  // Wert nur im aeusseren Ring [2][0]. Nur ein 5x5-Fenster sieht ihn.
  const frames = [];
  for (let i = 0; i <= 17; i++) {
    const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
    if (i === 16 || i === 17) grid[2][0] = R; // lead 75 bzw. 80
    if (i === 1) grid[2][0] = R; // lead 0: NEAR-Fenster sieht [2][0] nicht
    const validTime = at(i * 5);
    frames.push({ validTime, grid, isForecast: validTime.getTime() > now.getTime() });
  }
  const series = { fetchedAt: now, runTime: now, center: { row: 2, col: 2 }, frames };
  const out = computeNowcast(series, now, CONFIG);

  const near = out.forecast[0]; // index 1, lead 0
  assert.equal(near.maxMmh, 0, "NEAR-Fenster darf [2][0] nicht sehen");

  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].uncertain, true);
  assert.ok(out.events[0].peakMmh > 0, "FAR-Fenster muss [2][0] sehen");
});

test("Lauf 20 Minuten alt: stale", () => {
  const out = nc(new Array(25).fill(0), { runOffsetMin: 20 });
  assert.equal(out.ageMin, 20);
  assert.equal(out.freshness, "stale");
});

test("Lauf 40 Minuten alt: veryStale", () => {
  const out = nc(new Array(25).fill(0), { runOffsetMin: 40 });
  assert.equal(out.ageMin, 40);
  assert.equal(out.freshness, "veryStale");
});

test("null in Nachbarschaft und ein Frame ohne Daten: coverage partial", () => {
  const values = new Array(25).fill(R);
  values[5] = null; // ein Frame komplett ohne Daten
  const out = nc(values, { holes: [[0, 0]] }); // eine Zelle je Datenframe null
  assert.equal(out.coverage, "partial");
});

test("alle Frames ohne Daten: coverage none", () => {
  const out = nc(new Array(25).fill(null));
  assert.equal(out.coverage, "none");
  assert.equal(out.events.length, 0);
});

test("runTime null: Fallback greift, ageUncertain", () => {
  const out = nc(new Array(25).fill(0), { runTimeNull: true });
  assert.equal(out.runTime, null);
  assert.equal(out.ageUncertain, true);
  assert.equal(out.ageMin, 0); // now - current.validTime
});

test("Kategoriegrenzen exakt bei 2,5, 10 und 50 mm/h", () => {
  assert.equal(categorize(0.29, CONFIG), "none");
  assert.equal(categorize(0.3, CONFIG), "light");
  assert.equal(categorize(2.5, CONFIG), "light");
  assert.equal(categorize(2.51, CONFIG), "moderate");
  assert.equal(categorize(10, CONFIG), "moderate");
  assert.equal(categorize(10.01, CONFIG), "strong");
  assert.equal(categorize(50, CONFIG), "strong");
  assert.equal(categorize(50.01, CONFIG), "extreme");
});

test("Ereignis reicht bis zum Fensterende: openEnded", () => {
  const values = new Array(25).fill(0);
  for (let i = 20; i <= 24; i++) values[i] = R; // bis zum letzten Frame
  const out = nc(values);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].openEnded, true);
});

test("Fenster m10/m20/m120 beruecksichtigen leadMin-Grenzen", () => {
  const values = new Array(25).fill(0);
  values[8] = R; // lead 35 -> nur in m120
  values[9] = R;
  const out = nc(values);
  assert.equal(out.windows.m10.maxMmh, 0);
  assert.equal(out.windows.m20.maxMmh, 0);
  assert.ok(out.windows.m120.maxMmh > 0);
  assert.deepEqual(out.windows.m120.firstRainAt, at(35)); // frame8.vt - 5
});
