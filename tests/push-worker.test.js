import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker, { runAlerts, parseSubscribe } from "../push/src/index.js";
import { generateVapidKeys, b64urlEncode, b64urlDecode } from "../push/src/webpush.js";

const MIN = 60_000;
const ORIGIN = "https://regen.example.org";
const NOW = new Date("2026-11-10T12:00:00Z");

// --- Nachbauten -------------------------------------------------------------

/** KV-Namensraum im Speicher, zaehlt Schreibzugriffe. */
function memoryKv() {
  const data = new Map();
  return {
    data,
    writes: 0,
    async get(name, type) {
      const v = data.get(name);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(name, value) {
      this.writes++;
      data.set(name, value);
    },
    async delete(name) {
      data.delete(name);
    },
    async list({ prefix = "" } = {}) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

/** Browser-Seite eines Abos: echter ECDH-Schluessel, damit wir entschluesseln koennen. */
async function browserSubscription(host = "web.push.apple.com", path = "abc") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    json: { endpoint: `https://${host}/${path}`, keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } },
  };
}

/** Empfaengerseite von RFC 8291: Rumpf entschluesseln wie ein Browser. */
async function decrypt(body, browser) {
  const enc = new TextEncoder();
  const hmac = async (k, d) =>
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d)
    );
  const cat = (...p) => {
    const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let i = 0;
    for (const x of p) (o.set(x, i), (i += x.length));
    return o;
  };
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = b64urlDecode(browser.json.keys.p256dh);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, browser.privateKey, 256));
  const prkKey = await hmac(b64urlDecode(browser.json.keys.auth), secret);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  assert.equal(plain.at(-1), 2, "letzter Datensatz endet mit 0x02");
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

/** Bright-Sky-Antwort: ein Frame je 5 Minuten ab `now`, ueberall derselbe Wert. */
function radarResponse(values, now) {
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  return {
    radar: values.map((v, i) => ({
      timestamp: iso(now.getTime() + i * 5 * MIN),
      source: `RADOLAN::RV::${iso(now.getTime())}`,
      precipitation_5: Array.from({ length: 11 }, () => Array(11).fill(v)),
    })),
    latlon_position: { x: 5, y: 5 },
  };
}
const RAIN_IN_20 = [0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, ...new Array(14).fill(0)];
const DRY = new Array(25).fill(0);

function radarFetch(values, calls = []) {
  return async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(radarResponse(values, NOW)), { status: 200 });
  };
}

function pushService(status = 201, sent = []) {
  return async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status });
  };
}

let env;
let vapid;
beforeEach(async () => {
  vapid = await generateVapidKeys();
  env = {
    SUBS: memoryKv(),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:regen@example.org",
    ALLOWED_ORIGINS: ORIGIN,
    MAX_SUBSCRIPTIONS: "25",
  };
});

// Die Bestaetigung beim Abonnieren geht ueber das globale fetch. Fuer diese
// Tests umleiten und die Hintergrund-Aufgaben einsammeln.
let realFetch;
let globalPushes;
beforeEach(() => {
  realFetch = globalThis.fetch;
  globalPushes = [];
  globalThis.fetch = pushService(201, globalPushes);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ctx() {
  const tasks = [];
  return { tasks, waitUntil: (p) => tasks.push(p) };
}

function request(path, { method = "GET", origin = ORIGIN, body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://regenradar-push.example.workers.dev${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function subscribeVia(browser, place = { lat: 49.45251, lon: 11.07672, name: "Nürnberg" }) {
  const c = ctx();
  const res = await worker.fetch(request("/subscribe", { method: "POST", body: { subscription: browser.json, place, tz: "Europe/Berlin" } }), env, c);
  await Promise.all(c.tasks);
  return res;
}

// --- HTTP-Seite --------------------------------------------------------------

test("CORS: eigene App bekommt Freigabe, fremde Seiten nicht", async () => {
  const ok = await worker.fetch(request("/subscribe", { method: "OPTIONS" }), env, ctx());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const other = await worker.fetch(request("/subscribe", { method: "OPTIONS", origin: "https://boese.example" }), env, ctx());
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);

  const post = await worker.fetch(request("/subscribe", { method: "POST", origin: "https://boese.example", body: {} }), env, ctx());
  assert.equal(post.status, 403);
});

test("/vapid liefert den oeffentlichen Schluessel, ohne Konfiguration 503", async () => {
  const res = await worker.fetch(request("/vapid"), env, ctx());
  assert.deepEqual(await res.json(), { publicKey: vapid.publicKey });

  delete env.VAPID_PRIVATE_KEY;
  const missing = await worker.fetch(request("/vapid"), env, ctx());
  assert.equal(missing.status, 503);
});

test("Abonnieren: speichert gerundeten Ort und schickt eine Bestaetigung, die der Browser lesen kann", async () => {
  const browser = await browserSubscription();
  const res = await subscribeVia(browser);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, created: true });

  const [stored] = [...env.SUBS.data.values()].map((v) => JSON.parse(v));
  assert.deepEqual(stored.place, { lat: 49.453, lon: 11.077, name: "Nürnberg" });
  assert.equal(stored.state, null);

  assert.equal(globalPushes.length, 1);
  const msg = await decrypt(new Uint8Array(globalPushes[0].init.body), browser);
  assert.equal(msg.title, "Regenalarm ist an");
  assert.match(msg.body, /^Nürnberg: /);
});

test("Erneutes Abonnieren am selben Ort: keine zweite Bestaetigung, Zustand bleibt", async () => {
  const browser = await browserSubscription();
  await subscribeVia(browser);
  const key = [...env.SUBS.data.keys()][0];
  const rec = JSON.parse(env.SUBS.data.get(key));
  rec.state = { phase: "alerted", alertedAt: 1 };
  env.SUBS.data.set(key, JSON.stringify(rec));

  const res = await subscribeVia(browser);
  assert.deepEqual(await res.json(), { ok: true, created: false });
  assert.equal(globalPushes.length, 1);
  assert.deepEqual(JSON.parse(env.SUBS.data.get(key)).state, { phase: "alerted", alertedAt: 1 });

  // Anderer Ort: Zustand wird zurueckgesetzt.
  await subscribeVia(browser, { lat: 52.52, lon: 13.405, name: "Berlin" });
  assert.equal(JSON.parse(env.SUBS.data.get(key)).state, null);
});

test("Eingaben: fremde Ziele, kaputte Schluessel und ungueltige Orte werden abgewiesen", async () => {
  const b = await browserSubscription();
  const place = { lat: 49.45, lon: 11.08, name: "X" };
  const bad = (field, body) =>
    assert.throws(() => parseSubscribe(body), (e) => e.message === field, field);

  bad("endpoint", { subscription: { ...b.json, endpoint: "https://boese.example/x" }, place });
  bad("endpoint", { subscription: { ...b.json, endpoint: "http://web.push.apple.com/x" }, place });
  bad("endpoint", { subscription: { ...b.json, endpoint: "https://web.push.apple.com.boese.example/x" }, place });
  bad("keys", { subscription: { ...b.json, keys: { p256dh: "AAAA", auth: b.json.keys.auth } }, place });
  bad("place", { subscription: b.json, place: { lat: 91, lon: 0 } });
  bad("place", { subscription: b.json, place: { lat: "x", lon: 0 } });

  // Chromium ohne Googles API-Schluessel abonniert hier, nicht bei fcm.googleapis.com.
  const chromium = parseSubscribe({ subscription: { ...b.json, endpoint: "https://jmt17.google.com/fcm/send/x" }, place });
  assert.equal(new URL(chromium.subscription.endpoint).host, "jmt17.google.com");

  const ok = parseSubscribe({ subscription: b.json, place: { ...place, name: "  " }, tz: "Mars/Olympus" });
  assert.equal(ok.place.name, "Standort");
  assert.equal(ok.tz, "Europe/Berlin");

  const res = await worker.fetch(request("/subscribe", { method: "POST", body: { subscription: b.json, place: { lat: 999, lon: 0 } } }), env, ctx());
  assert.equal(res.status, 400);
});

test("Obergrenze: weitere Geraete werden abgewiesen, bestehende duerfen aktualisieren", async () => {
  env.MAX_SUBSCRIPTIONS = "1";
  const a = await browserSubscription("web.push.apple.com", "a");
  const b = await browserSubscription("web.push.apple.com", "b");
  assert.equal((await subscribeVia(a)).status, 200);
  assert.equal((await subscribeVia(b)).status, 429);
  assert.equal((await subscribeVia(a)).status, 200);
});

test("Abmelden loescht das Abo", async () => {
  const browser = await browserSubscription();
  await subscribeVia(browser);
  const res = await worker.fetch(request("/unsubscribe", { method: "POST", body: { endpoint: browser.json.endpoint } }), env, ctx());
  assert.equal(res.status, 200);
  assert.equal(env.SUBS.data.size, 0);
});

// --- Cron-Lauf ---------------------------------------------------------------

test("Cron: Regen in 20 Minuten ergibt genau eine lesbare Mitteilung, der naechste Lauf bleibt still", async () => {
  const browser = await browserSubscription();
  await subscribeVia(browser);
  env.SUBS.writes = 0;

  const radarCalls = [];
  const sent = [];
  let stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20, radarCalls), pushFetch: pushService(201, sent) });
  assert.deepEqual(stats, { abos: 1, orte: 1, gesendet: 1, entfernt: 0, fehler: 0 });
  assert.match(radarCalls[0], /distance=5000/);

  const { url, init } = sent[0];
  assert.equal(url, browser.json.endpoint);
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(init.headers.TTL, "1800");
  assert.match(init.headers.Authorization, /^vapid t=.+, k=/);
  const msg = await decrypt(init.body, browser);
  assert.deepEqual(msg, {
    title: "Mäßiger Regen in 20 Minuten",
    body: "Nürnberg: ab 13:20, etwa 30 Minuten.",
    tag: "regenalarm",
  });
  assert.equal(env.SUBS.writes, 1, "Zustand einmal gespeichert");

  // Fuenf Minuten spaeter, dieselbe Lage: keine Nachricht, kein Schreibzugriff.
  const later = new Date(NOW.getTime() + 5 * MIN);
  stats = await runAlerts(env, later, { radarFetch: radarFetch(RAIN_IN_20.slice(1)), pushFetch: pushService(201, sent) });
  assert.equal(stats.gesendet, 0);
  assert.equal(sent.length, 1);
  assert.equal(env.SUBS.writes, 1);
});

test("Cron: trocken schreibt nichts und sendet nichts", async () => {
  await subscribeVia(await browserSubscription());
  env.SUBS.writes = 0;
  const sent = [];
  const stats = await runAlerts(env, NOW, { radarFetch: radarFetch(DRY), pushFetch: pushService(201, sent) });
  assert.equal(stats.gesendet, 0);
  assert.equal(sent.length, 0);
  assert.equal(env.SUBS.writes, 0);
});

test("Cron: ein Radarabruf pro Ort, nicht pro Abo", async () => {
  await subscribeVia(await browserSubscription("web.push.apple.com", "a"));
  await subscribeVia(await browserSubscription("fcm.googleapis.com", "b"));
  const calls = [];
  const sent = [];
  const stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20, calls), pushFetch: pushService(201, sent) });
  assert.equal(calls.length, 1);
  assert.equal(stats.gesendet, 2);
});

/** Anlagezeitpunkt eines gespeicherten Abos setzen. */
function setCreatedAt(date) {
  const [key, value] = [...env.SUBS.data.entries()][0];
  env.SUBS.data.set(key, JSON.stringify({ ...JSON.parse(value), createdAt: date.toISOString() }));
}

test("Cron: abgelaufenes Abo (410) wird geloescht", async () => {
  await subscribeVia(await browserSubscription());
  setCreatedAt(new Date(NOW.getTime() - 60 * MIN));
  const stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20), pushFetch: pushService(410) });
  assert.equal(stats.entfernt, 1);
  assert.equal(env.SUBS.data.size, 0);
});

test("Cron: ein frisches Abo wird bei 410 nicht geloescht, sondern erneut versucht", async () => {
  // Bei Googles Push-Dienst beobachtet: ein brandneues Abo lieferte 410,
  // Sekunden spaeter klappte die Zustellung an dasselbe Abo.
  await subscribeVia(await browserSubscription());
  setCreatedAt(new Date(NOW.getTime() - 2 * MIN));
  let stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20), pushFetch: pushService(410) });
  assert.equal(stats.entfernt, 0);
  assert.equal(stats.fehler, 1);
  assert.equal(env.SUBS.data.size, 1);

  const sent = [];
  const later = new Date(NOW.getTime() + 5 * MIN);
  stats = await runAlerts(env, later, { radarFetch: radarFetch(RAIN_IN_20.slice(1)), pushFetch: pushService(201, sent) });
  assert.equal(stats.gesendet, 1, "naechster Lauf stellt zu");
});

test("Cron: Fehler beim Push-Dienst schreibt den Zustand nicht fort, der naechste Lauf versucht es erneut", async () => {
  await subscribeVia(await browserSubscription());
  let stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20), pushFetch: pushService(500) });
  assert.equal(stats.fehler, 1);
  assert.equal(JSON.parse([...env.SUBS.data.values()][0]).state, null);

  const sent = [];
  stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20), pushFetch: pushService(201, sent) });
  assert.equal(stats.gesendet, 1);
});

test("Cron: Radarfehler an einem Ort stoppt die anderen nicht", async () => {
  const a = await browserSubscription("web.push.apple.com", "a");
  const b = await browserSubscription("web.push.apple.com", "b");
  await subscribeVia(a, { lat: 49.45, lon: 11.08, name: "A" });
  await subscribeVia(b, { lat: 52.52, lon: 13.4, name: "B" });
  let first = true;
  const flaky = async () => {
    if (first) {
      first = false;
      return new Response("kaputt", { status: 502 });
    }
    return new Response(JSON.stringify(radarResponse(RAIN_IN_20, NOW)), { status: 200 });
  };
  const stats = await runAlerts(env, NOW, { radarFetch: flaky, pushFetch: pushService(201) });
  assert.equal(stats.fehler, 1);
  assert.equal(stats.gesendet, 1);
});

test("Cron: ohne VAPID-Konfiguration kein Versand und kein Absturz", async () => {
  await subscribeVia(await browserSubscription());
  delete env.VAPID_SUBJECT;
  const sent = [];
  const stats = await runAlerts(env, NOW, { radarFetch: radarFetch(RAIN_IN_20), pushFetch: pushService(201, sent) });
  assert.equal(sent.length, 0);
  assert.equal(stats.abos, 0);
});

test("Cron: der Radarabruf schickt Accept-Encoding mit und kein cache-Feld", async () => {
  // Bright Sky lehnt format=plain ohne Accept-Encoding mit HTTP 400 ab; im
  // echten Laufzeitsystem (wrangler dev) war genau das der Fall. Hier laeuft
  // der Standard-Abruf des Workers, nur das globale fetch ist umgeleitet.
  await subscribeVia(await browserSubscription());
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(radarResponse(DRY, NOW)), { status: 200 });
  };
  const stats = await runAlerts(env, NOW, { pushFetch: pushService(201) });
  assert.equal(stats.orte, 1);
  const radar = seen.find((c) => c.url.includes("/radar?"));
  assert.equal(radar.init.headers["Accept-Encoding"], "gzip");
  assert.equal(radar.init.headers.Accept, "application/json");
  assert.equal("cache" in radar.init, false);
});
