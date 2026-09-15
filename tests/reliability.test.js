import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNowcast } from '../src/nowcast.js';
import { summarize, hhmm } from '../src/text.js';
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

test('normaler Laufverzug zeigt das echte Ende statt einer Datenlueckenwarnung', () => {
  for (const delay of [2.5, 7.65, 10, 20, 40]) {
    const out = compute(buildSeries(new Array(25).fill(0)), at(delay));
    assert.equal(out.coverage, 'shortened');
    assert.equal(out.forecast.at(-1).noData, true);
    assert.deepEqual(out.forecastUntil, at(120));
    const s = summarize(out);
    assert.equal(s.title, `Kein Regen bis ${hhmm(at(120))}`);
    assert.equal(s.headline, `Kein Regen bis ${hhmm(at(120))}.`);
    assert.match(s.status, /Vorhersage bis/);
    assert.doesNotMatch(s.headline, /2 Stunden|unvollständig/);
    if (delay === 40) assert.match(s.status, /Daten veraltet/);
  }
});

test('Regen bis zum verkuerzten Ende verspricht keine vollen zwei Stunden', () => {
  const out = compute(buildSeries(new Array(25).fill(50)), at(7.65));
  assert.equal(out.coverage, 'shortened');
  assert.equal(out.events[0].openEnded, true);
  assert.equal(summarize(out).headline,
    `Es regnet gerade, mäßig (6,0 mm/h). Hält voraussichtlich bis mindestens ${hhmm(at(120))} an.`);
});

test('nach endendem Regen wird trocken nur bis zum Laufende behauptet', () => {
  const values = new Array(25).fill(0);
  values.fill(50, 0, 5);
  const out = compute(buildSeries(values), at(7.65));
  assert.equal(summarize(out).detail, `Danach trocken bis ${hhmm(at(120))}.`);
});

test('echte Luecken bleiben trotz normalem Laufverzug partial', () => {
  for (const index of [3, 12, 24]) {
    const series = buildSeries(new Array(25).fill(0));
    series.frames.splice(index, 1);
    const out = compute(series, at(7.65));
    assert.equal(out.coverage, 'partial');
    assert.equal(summarize(out).title, 'Vorhersage unvollständig');
  }
});

test('Nullwerte bleiben trotz normalem Laufverzug Datenluecken', () => {
  const values = new Array(25).fill(0);
  values[12] = null;
  assert.equal(compute(buildSeries(values), at(7.65)).coverage, 'partial');
  assert.equal(compute(buildSeries(new Array(25).fill(0), {
    holes: [[2, 2]],
  }), at(7.65)).coverage, 'partial');
});

test('ohne bekannten Lauf wird ein fehlendes Ende nicht als normal angenommen', () => {
  const out = compute(buildSeries(new Array(25).fill(0), { runTimeNull: true }), at(10));
  assert.equal(out.coverage, 'partial');
});

test('abgelaufener Lauf liefert keine Trockenprognose', () => {
  const out = compute(buildSeries(new Array(25).fill(0)), at(125));
  assert.equal(out.coverage, 'none');
  assert.equal(out.forecastUntil, null);
});
