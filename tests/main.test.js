import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as config from '../src/config.js';
import { ApiError } from '../src/api.js';
import { computeNowcast } from '../src/nowcast.js';
import { summarize } from '../src/text.js';
import { buildSeries } from './helpers.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

// Fuehrt den echten Controller mit kontrollierten API- und UI-Grenzen aus.
// Nur die statischen Imports und der automatische Boot werden ersetzt.
function harness() {
  const requests = { radar: [], alerts: [], weather: [], geo: [] };
  const views = [], alertViews = [], saved = [];
  const cache = new Map();
  const places = [{ id: 'a', name: 'A', lat: 49, lon: 11 }, { id: 'b', name: 'B', lat: 52, lon: 13 }];
  const request = type => args => {
    const d = deferred();
    requests[type].push({ ...d, args });
    return d.promise;
  };
  const context = vm.createContext({
    ...config, ApiError, computeNowcast, summarize,
    fetchRadarSeries: request('radar'), fetchAlerts: request('alerts'), fetchCurrentWeather: request('weather'),
    loadLast: id => cache.get(id), saveLast: (id, series) => saved.push({ id, series }),
    setActiveId() {}, loadPlaces: () => places, saveGeoName() {},
    render: v => views.push(v), renderAlerts: v => alertViews.push(v),
    setAlertBadge() {}, closePlaceForm() {},
    navigator: { onLine: true, geolocation: { getCurrentPosition(resolve, reject) { requests.geo.push({ resolve, reject }); } } },
    document: { body: { dataset: {} } },
    Date, setTimeout, clearTimeout,
  });
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+"[^"\n]+";\n/gm, '')
    .replace(/\nboot\(\);\s*$/, '\nglobalThis.app = { state, activate, load, loadAlerts, refreshAll };');
  vm.runInContext(source, context);
  context.app.state.places = places;
  return { ...context.app, requests, views, alertViews, saved, cache, dataset: context.document.body.dataset };
}
function radar(coords) {
  return { ...buildSeries(new Array(25).fill(0)), coords, fetchedAt: new Date() };
}
const alerts = () => ({ count: 0, groups: [], location: null, fetchedAt: new Date() });

test('Ortswechsel A-B-A: alte Antworten und finally veraendern neue Aktivierung nicht', async () => {
  const h = harness();
  h.activate('a'); h.activate('b'); h.activate('a');
  assert.equal(h.requests.radar.length, 3);
  h.requests.radar[0].resolve(radar({ lat: 49, lon: 11 }));
  h.requests.alerts[0].resolve(alerts());
  h.requests.weather[0].resolve({ temperature: 99 });
  await flush();
  assert.equal(h.saved.length, 0);
  assert.equal(h.state.current, null);
  assert.equal(h.state.alerts, null);
  assert.equal(h.state.loading, true);
  h.requests.radar[1].reject(new Error('old failure'));
  h.requests.alerts[1].resolve(alerts()); h.requests.weather[1].resolve(null);
  await flush();
  assert.equal(h.state.currentState, 'loading');
  h.requests.radar[2].resolve(radar({ lat: 49, lon: 11 }));
  h.requests.alerts[2].resolve(alerts()); h.requests.weather[2].resolve(null);
  await flush();
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].id, 'a');
  assert.equal(h.state.loading, false);
});

test('verspaetete Geolocation startet keine Requests fuer alten Ort', async () => {
  const h = harness();
  h.activate('geo'); h.activate('b');
  h.requests.geo[0].resolve({ coords: { latitude: 48, longitude: 10 } });
  await flush();
  assert.equal(h.requests.radar.length, 1);
  assert.equal(h.requests.radar[0].args.lat, 52);
});

test('Warnungen laden trotz Radarfehler und Refresh wartet auf sie', async () => {
  const h = harness();
  h.state.activeId = 'a';
  const refresh = h.refreshAll();
  assert.equal(h.requests.alerts.length, 1);
  h.requests.radar[0].reject(new Error('radar unavailable'));
  h.requests.weather[0].resolve(null);
  await flush();
  assert.equal(h.state.currentState, 'error');
  assert.equal(h.dataset.refreshing, '1');
  h.requests.alerts[0].resolve(alerts());
  await refresh;
  assert.equal(h.state.alertsState, 'ok');
  assert.equal(h.dataset.refreshing, undefined);
});

test('Refresh fragt Warnungen erst mit neuer GPS-Position ab', async () => {
  const h = harness();
  h.state.activeId = 'geo';
  h.state.geoName = { key: '49,11', name: 'Alter Ort' };
  const refresh = h.refreshAll();
  assert.equal(h.requests.alerts.length, 0);
  h.requests.geo[0].resolve({ coords: { latitude: 52, longitude: 13 } });
  await flush();
  assert.equal(h.requests.alerts[0].args.lat, 52);
  assert.equal(h.requests.radar[0].args.lat, 52);
  h.requests.alerts[0].resolve(alerts()); h.requests.radar[0].resolve(radar({ lat: 52, lon: 13 }));
  h.requests.weather[0].resolve(null);
  await refresh;
});

test('frischer Radarcache verhindert Warnungsabruf nicht', async () => {
  const h = harness();
  h.cache.set('a', radar({ lat: 49, lon: 11 }));
  h.activate('a');
  assert.equal(h.requests.radar.length, 0);
  assert.equal(h.requests.alerts.length, 1);
  h.requests.alerts[0].resolve(alerts());
  await flush();
  assert.equal(h.state.alertsState, 'ok');
});

test('fehlgeschlagener Warnungsrefresh behaelt Daten und kennzeichnet Fehler', async () => {
  const h = harness();
  h.state.activeId = 'a';
  h.state.alerts = alerts();
  const task = h.loadAlerts(true);
  h.requests.alerts[0].reject(new Error('offline'));
  await task;
  assert.equal(h.alertViews.at(-1).state, 'error');
  assert.equal(h.alertViews.at(-1).alerts.count, 0);
});
