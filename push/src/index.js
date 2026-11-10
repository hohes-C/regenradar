// Regenalarm-Worker. Nimmt Push-Abos der App entgegen, prueft alle fuenf
// Minuten per Cron-Trigger das Radar fuer jeden abonnierten Ort und schickt
// eine Mitteilung, wenn Regen im Anmarsch ist.
//
// Endpunkte: GET /vapid, POST /subscribe, POST /unsubscribe.
// Bindings: SUBS (KV). Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
// Vars: ALLOWED_ORIGINS (kommagetrennt), MAX_SUBSCRIPTIONS.

import { fetchRadarSeries } from "../../src/api.js";
import { computeNowcast } from "../../src/nowcast.js";
import {
  CONFIG,
  COORD_DECIMALS,
  PUSH_ALERT_WINDOW_MIN,
  PUSH_COOLDOWN_MIN,
  PUSH_RADAR_DISTANCE_M,
} from "../../src/config.js";
import { b64urlDecode, sendNotification } from "./webpush.js";
import { decide, rainMessage } from "./rain.js";

const PREFIX = "sub:";
const MAX_BODY = 4096;
// So lange gilt ein Abo als frisch und wird bei 404/410 nicht geloescht.
const YOUNG_MS = 10 * 60_000;

// Nur an die Push-Dienste der Browser wird gesendet. Sonst liesse sich der
// Worker mit einem erfundenen Abo als Weiterleitung fuer beliebige Ziele nutzen.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Android
  /^jmt17\.google\.com$/, // Chromium-Builds ohne Googles API-Schluessel (z. B. aus Linux-Distributionen)
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari, iOS
  /\.notify\.windows\.com$/, // Edge
];

class BadRequest extends Error {}

// Radarabruf aus dem Worker. Zwei Unterschiede zum Browser:
// - Bright Sky lehnt format=plain ohne Accept-Encoding mit HTTP 400 ab. Browser
//   schicken den Kopf immer, der Worker nicht von selbst.
// - RequestInit.cache kennen Workers je nach Kompatibilitaetsdatum nicht und
//   werfen dann. Die URL enthaelt ohnehin den Zeitstempel, es gibt nichts zu cachen.
const workerFetch = (url, init = {}) => {
  const { cache, headers, ...rest } = init;
  return fetch(url, { ...rest, headers: { ...headers, "Accept-Encoding": "gzip" } });
};

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function vapidFromEnv(env) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

async function idFor(endpoint) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const round = (n) => Number(n.toFixed(COORD_DECIMALS));

function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.length > 64) return "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: tz });
    return tz;
  } catch {
    return "Europe/Berlin";
  }
}

/** Eingaben pruefen und auf das Noetige reduzieren. Wirft BadRequest. */
export function parseSubscribe(body) {
  const sub = body?.subscription;
  let endpoint;
  try {
    endpoint = new URL(sub?.endpoint);
  } catch {
    throw new BadRequest("endpoint");
  }
  if (endpoint.protocol !== "https:" || !PUSH_HOSTS.some((re) => re.test(endpoint.hostname))) {
    throw new BadRequest("endpoint");
  }
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  try {
    const pk = b64urlDecode(p256dh);
    if (pk.length !== 65 || pk[0] !== 4 || b64urlDecode(auth).length !== 16) throw new Error();
  } catch {
    throw new BadRequest("keys");
  }

  const lat = Number(body?.place?.lat);
  const lon = Number(body?.place?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new BadRequest("place");
  }
  const name = String(body?.place?.name ?? "").trim().slice(0, 60) || "Standort";

  return {
    subscription: { endpoint: endpoint.href, keys: { p256dh, auth } },
    place: { lat: round(lat), lon: round(lon), name },
    tz: validTimeZone(body?.tz),
  };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new BadRequest("size");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("json");
  }
}

async function countSubscriptions(kv) {
  let n = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

async function subscribe(request, env, ctx, cors) {
  const input = parseSubscribe(await readJson(request));
  const id = await idFor(input.subscription.endpoint);
  const existing = await env.SUBS.get(PREFIX + id, "json");

  if (!existing) {
    const max = Number(env.MAX_SUBSCRIPTIONS ?? 10);
    if ((await countSubscriptions(env.SUBS)) >= max) return json({ error: "full" }, 429, cors);
  }

  // Neuer Ort: Zustand zuruecksetzen, sonst bliebe ein Alarm vom alten Ort haengen.
  const samePlace = existing && existing.place.lat === input.place.lat && existing.place.lon === input.place.lon;
  const record = {
    id,
    ...input,
    state: samePlace ? existing.state : null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  await env.SUBS.put(PREFIX + id, JSON.stringify(record));

  // Bestaetigung nur beim ersten Einrichten: so sieht man sofort, ob Push auf
  // dem Geraet ueberhaupt ankommt, ohne auf Regen zu warten.
  const vapid = vapidFromEnv(env);
  if (!existing && vapid) {
    const payload = JSON.stringify({
      title: "Regenalarm ist an",
      body: `${record.place.name}: Du bekommst eine Mitteilung, wenn in den nächsten ${PUSH_ALERT_WINDOW_MIN} Minuten Regen kommt.`,
      tag: "regenalarm-an",
    });
    ctx.waitUntil(
      sendNotification({ subscription: record.subscription, payload, vapid, ttl: 600 })
        .then((res) => {
          if (!res.ok) console.warn("Bestaetigung vom Push-Dienst abgelehnt, HTTP", res.status);
        })
        .catch((err) => console.warn("Bestaetigung fehlgeschlagen", err?.message))
    );
  }
  return json({ ok: true, created: !existing }, 200, cors);
}

async function unsubscribe(request, env, cors) {
  const body = await readJson(request);
  if (typeof body?.endpoint !== "string") throw new BadRequest("endpoint");
  await env.SUBS.delete(PREFIX + (await idFor(body.endpoint)));
  return json({ ok: true }, 200, cors);
}

async function loadAll(kv) {
  const records = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const { name } of page.keys) {
      const rec = await kv.get(name, "json");
      if (rec) records.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

const sameState = (a, b) => (a?.phase ?? "dry") === (b?.phase ?? "dry") && (a?.alertedAt ?? null) === (b?.alertedAt ?? null);

/**
 * Ein Cron-Lauf. Ein Radarabruf pro Ort, nicht pro Abo. In KV wird nur
 * geschrieben, wenn sich der Zustand eines Abos aendert: das Gratiskontingent
 * erlaubt 1.000 Schreibzugriffe am Tag, ein Lauf alle fuenf Minuten sind 288.
 */
export async function runAlerts(env, now, deps = {}) {
  const radarFetch = deps.radarFetch ?? workerFetch;
  const pushFetch = deps.pushFetch ?? fetch;
  const stats = { abos: 0, orte: 0, gesendet: 0, entfernt: 0, fehler: 0 };
  const vapid = vapidFromEnv(env);
  if (!vapid) {
    console.error("VAPID-Schluessel oder VAPID_SUBJECT fehlen, kein Versand");
    return stats;
  }

  const records = await loadAll(env.SUBS);
  stats.abos = records.length;
  const byPlace = new Map();
  for (const rec of records) {
    const key = `${rec.place.lat},${rec.place.lon}`;
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(rec);
  }

  for (const recs of byPlace.values()) {
    const { lat, lon } = recs[0].place;
    let nowcast;
    try {
      const series = await fetchRadarSeries({ lat, lon, now, distance: PUSH_RADAR_DISTANCE_M, fetchImpl: radarFetch });
      nowcast = computeNowcast(series, now, CONFIG);
      stats.orte++;
    } catch (err) {
      stats.fehler++;
      console.warn("Radar", lat, lon, err?.message);
      continue;
    }

    for (const rec of recs) {
      const { state, notify } = decide(nowcast, rec.state, {
        windowMin: PUSH_ALERT_WINDOW_MIN,
        cooldownMin: PUSH_COOLDOWN_MIN,
      });
      if (notify) {
        const msg = rainMessage(notify, now, { place: rec.place.name, timeZone: rec.tz });
        const payload = JSON.stringify({ ...msg, tag: "regenalarm" });
        let res;
        try {
          res = await sendNotification({
            subscription: rec.subscription,
            payload,
            vapid,
            ttl: PUSH_ALERT_WINDOW_MIN * 60, // spaeter zugestellt waere die Warnung wertlos
            fetchImpl: pushFetch,
          });
        } catch (err) {
          res = { ok: false, gone: false, status: err?.message };
        }
        // Ein ganz frisches Abo kann beim Push-Dienst kurz noch unbekannt sein:
        // Googles Dienst meldete fuer ein neues Abo 410, Sekunden spaeter kam
        // die Zustellung an dasselbe Abo durch. Junge Abos daher nicht loeschen,
        // sondern wie einen Fehler behandeln und beim naechsten Lauf erneut senden.
        const young = now.getTime() - Date.parse(rec.createdAt) < YOUNG_MS;
        if (res.gone && !young) {
          await env.SUBS.delete(PREFIX + rec.id);
          stats.entfernt++;
          continue;
        }
        if (!res.ok) {
          // Zustand nicht fortschreiben: der naechste Lauf versucht es erneut.
          stats.fehler++;
          console.warn("Push", res.status);
          continue;
        }
        stats.gesendet++;
      }
      if (!sameState(state, rec.state)) {
        await env.SUBS.put(PREFIX + rec.id, JSON.stringify({ ...rec, state }));
      }
    }
  }
  console.log(JSON.stringify(stats));
  return stats;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    // Browser schicken bei POST immer Origin mit; nur die eigene App darf abonnieren.
    if (request.method === "POST" && !allowedOrigins(env).includes(origin)) {
      return json({ error: "origin" }, 403, cors);
    }

    try {
      if (request.method === "GET" && url.pathname === "/vapid") {
        const vapid = vapidFromEnv(env);
        return vapid ? json({ publicKey: vapid.publicKey }, 200, cors) : json({ error: "not_configured" }, 503, cors);
      }
      if (request.method === "POST" && url.pathname === "/subscribe") return await subscribe(request, env, ctx, cors);
      if (request.method === "POST" && url.pathname === "/unsubscribe") return await unsubscribe(request, env, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: "bad_request", field: err.message }, 400, cors);
      console.error(err);
      return json({ error: "internal" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env, new Date(event.scheduledTime)));
  },
};
