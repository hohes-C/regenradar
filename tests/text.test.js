import { test } from "node:test";
import assert from "node:assert/strict";

import { computeNowcast } from "../src/nowcast.js";
import { summarize, hhmm, fmtRate } from "../src/text.js";
import { CONFIG } from "../src/config.js";
import { buildSeries, at, BASE_NOW } from "./helpers.js";

const now = BASE_NOW;
const nc = (values, opts) => computeNowcast(buildSeries(values, opts), now, CONFIG);
const R = 50; // 6 mm/h moderate

test("Formatierung: hhmm und fmtRate", () => {
  // hhmm formatiert in lokaler Zeit; Optionen (24h, 2-stellig) werden geprueft.
  const local = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const d = new Date("2026-01-01T16:30:00Z");
  assert.equal(hhmm(d), local.format(d));
  assert.match(hhmm(d), /^\d{2}:\d{2}$/);

  assert.equal(fmtRate(5.4), "5,4");
  assert.equal(fmtRate(0.3), "0,3");
  assert.equal(fmtRate(6), "6,0"); // unter 10: eine Nachkommastelle
  assert.equal(fmtRate(12), "12"); // ab 10: ganzzahlig
  assert.equal(fmtRate(2.5), "2,5");
});

test("coverage none", () => {
  const out = nc(new Array(25).fill(null));
  assert.equal(summarize(out).headline, "Keine Radardaten für diesen Ort.");
});

test("kein Regen", () => {
  const out = nc(new Array(25).fill(0));
  assert.equal(summarize(out).headline, "Kein Regen in den nächsten 2 Stunden.");
});

test("isolierte Frames: vereinzelt Tropfen", () => {
  const values = new Array(25).fill(0);
  values[1] = R;
  const out = nc(values);
  const iso = out.isolatedFrames[0].validTime;
  assert.equal(
    summarize(out).headline,
    `Weitgehend trocken, vereinzelt Tropfen möglich gegen ${hhmm(iso)}.`
  );
});

test("Regen jetzt, endet im Fenster", () => {
  const values = new Array(25).fill(0);
  for (let i = 0; i <= 7; i++) values[i] = R;
  const out = nc(values);
  const s = summarize(out);
  assert.equal(
    s.headline,
    `Es regnet gerade, mäßig (6,0 mm/h). Lässt voraussichtlich gegen ${hhmm(at(35))} nach.`
  );
  assert.equal(s.detail, "Danach trocken.");
});

test("Regen jetzt, openEnded", () => {
  const values = new Array(25).fill(R); // durchgehend
  const out = nc(values);
  const s = summarize(out);
  assert.equal(
    s.headline,
    "Es regnet gerade, mäßig (6,0 mm/h). Hält voraussichtlich die nächsten 2 Stunden an."
  );
  assert.equal(s.detail, null);
});

test("Regen beginnt in 30 Minuten", () => {
  const values = new Array(25).fill(0);
  for (let i = 7; i <= 11; i++) values[i] = R;
  const out = nc(values);
  assert.equal(
    summarize(out).headline,
    "Trocken, in 30 Minuten mäßiger Regen bis 6,0 mm/h, etwa 25 Minuten."
  );
});

test("Regen beginnt gleich (unter 3 Minuten)", () => {
  const values = new Array(25).fill(0);
  values[1] = R; // lead 0
  values[2] = R;
  const out = nc(values);
  assert.equal(
    summarize(out).headline,
    "Gleich mäßiger Regen bis 6,0 mm/h, etwa 10 Minuten."
  );
});

test("Regen beginnt nach 30 Minuten", () => {
  const values = new Array(25).fill(0);
  for (let i = 12; i <= 14; i++) values[i] = R; // start now+55
  const out = nc(values);
  assert.equal(
    summarize(out).headline,
    `Trocken bis etwa ${hhmm(at(55))}, dann mäßiger Regen bis 6,0 mm/h, etwa 15 Minuten.`
  );
});

test("Tendenz bei uncertain (Start nach 60 Minuten)", () => {
  const values = new Array(25).fill(0);
  for (let i = 16; i <= 18; i++) values[i] = R; // start now+75, lead 75
  const out = nc(values);
  assert.equal(
    summarize(out).headline,
    `Tendenz: ab etwa ${hhmm(at(75))} möglicherweise mäßiger Regen.`
  );
});

test("openEnded kuenftig: mindestens statt etwa", () => {
  const values = new Array(25).fill(0);
  for (let i = 13; i <= 24; i++) values[i] = R; // start now+60 (lead 60, nicht uncertain), bis Fensterende
  const out = nc(values);
  assert.equal(out.events[0].uncertain, false);
  assert.equal(out.events[0].openEnded, true);
  assert.equal(
    summarize(out).headline,
    `Trocken bis etwa ${hhmm(at(60))}, dann mäßiger Regen bis 6,0 mm/h, mindestens 60 Minuten.`
  );
});

test("zwei Ereignisse: detail Weiterer Schauer", () => {
  const values = new Array(25).fill(0);
  for (let i = 3; i <= 4; i++) values[i] = R;
  for (let i = 9; i <= 10; i++) values[i] = R;
  const out = nc(values);
  const s = summarize(out);
  assert.equal(s.detail, `Weiterer Schauer gegen ${hhmm(out.events[1].start)}, mäßig.`);
});

test("mehr als zwei Ereignisse: detail Wechselhaft", () => {
  const values = new Array(25).fill(0);
  for (const [a, b] of [[2, 3], [8, 9], [14, 15]]) for (let i = a; i <= b; i++) values[i] = R;
  const out = nc(values);
  const s = summarize(out);
  assert.equal(out.events.length, 3);
  assert.equal(s.detail, `Wechselhaft, 3 Schauer bis ${hhmm(out.events[2].end)}.`);
});

test("status fuer alle drei freshness-Werte", () => {
  const dry = new Array(25).fill(0);
  const fresh = summarize(nc(dry));
  assert.equal(fresh.status, `Stand ${hhmm(now)}`);

  const stale = summarize(nc(dry, { runOffsetMin: 20 }));
  assert.equal(stale.status, "Daten 20 Minuten alt");

  const very = summarize(nc(dry, { runOffsetMin: 40 }));
  assert.equal(very.status, "Daten veraltet (40 Minuten), Vorhersage unsicher");
});

test("status ageUncertain haengt (geschätzt) an", () => {
  const out = nc(new Array(25).fill(0), { runTimeNull: true });
  assert.equal(summarize(out).status, `Stand ${hhmm(now)} (geschätzt)`);
});
