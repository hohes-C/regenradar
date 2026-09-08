import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNowcast } from '../src/nowcast.js';
import { summarize } from '../src/text.js';
import { CONFIG } from '../src/config.js';
import { buildSeries, BASE_NOW, at } from './helpers.js';

const compute = (series, now = BASE_NOW) => computeNowcast(series, now, CONFIG);

test('nur zehn Minuten Daten ergeben keine zweistuendige Trockenprognose', () => {
  const out = compute(buildSeries([0, 0, 0]));
  assert.equal(out.coverage, 'partial');
  assert.equal(out.forecast.length, 24);
  assert.equal(out.forecast.filter(f => f.noData).length, 22);
  assert.match(summarize(out).headline, /fehlen.*Daten/);
  assert.doesNotMatch(summarize(out).headline, /^Kein Regen in/);
});

test('55 Minuten fehlende Frames verbinden keine Regenereignisse', () => {
  const series = buildSeries(new Array(25).fill(0));
  series.frames = series.frames.filter((f, i) => i === 0 || i === 1 || i >= 12);
  for (const i of [1, 2]) series.frames[i].grid.forEach(row => row.fill(50));
  const out = compute(series);
  assert.equal(out.coverage, 'partial');
  assert.equal(out.events.length, 0);
  assert.equal(out.isolatedFrames.length, 2);
});

test('Null-Frame unterbricht Regen, Ende wird nicht als bekannt behauptet', () => {
  const values = new Array(25).fill(0);
  values.splice(0, 5, 50, 50, null, 50, 50);
  const out = compute(buildSeries(values));
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].openEnded, true);
  assert.match(summarize(out).headline, /unvollständig/);
  assert.equal(summarize(out).detail, null);
});

test('ein aktueller starker Frame wird nicht als Tropfen verworfen', () => {
  const values = new Array(25).fill(0);
  values[0] = 500;
  const out = compute(buildSeries(values, { neighbors: 'zero' }));
  assert.equal(out.events[0].startsNow, true);
  assert.equal(out.events[0].peakMmh, 60);
  assert.match(summarize(out).headline, /sehr stark \(60 mm\/h\)/);
  assert.doesNotMatch(summarize(out).headline, /Tropfen|trocken/);
});

test('auch ein einzelner kuenftiger intensiver Frame bleibt ein Ereignis', () => {
  const values = new Array(25).fill(0);
  values[6] = 100;
  const out = compute(buildSeries(values));
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].peakCategory, 'strong');
  assert.equal(out.events[0].durationMin, 5);
});

test('alter letzter Frame ist kein aktueller Regen', () => {
  const out = compute(buildSeries([500]), at(20));
  assert.equal(out.current, null);
  assert.equal(out.coverage, 'none');
  assert.equal(out.events.length, 0);
});

test('fortschreitende Uhr macht verkuerzte Prognose sichtbar', () => {
  const out = compute(buildSeries(new Array(25).fill(0)), at(10));
  assert.equal(out.coverage, 'partial');
  assert.equal(out.forecast.at(-1).noData, true);
});
