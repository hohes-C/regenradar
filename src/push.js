// Regenalarm auf der App-Seite: Web-Push-Abo anlegen, abmelden und den Ort
// beim Worker aktuell halten. Der Worker liegt unter PUSH_URL (Verzeichnis
// push/ im Repo). Ohne PUSH_URL bleibt die Funktion ausgeblendet.
//
// Auf iPhone und iPad gibt es Web Push nur in einer Web-App, die zum
// Home-Bildschirm hinzugefuegt wurde (ab iOS 16.4). In Safari selbst fehlt
// dort die PushManager-Schnittstelle ganz.

import { PUSH_URL, COORD_DECIMALS } from "./config.js";

const KEY_STORE = "regenradar.push.publicKey";
const PLACE_STORE = "regenradar.push.place"; // zuletzt an den Worker gemeldeter Ort
const OWNER_STORE = "regenradar.push.owner"; // Ort der App, fuer den der Alarm gilt ("geo" oder id)

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* Speicher blockiert: dann eben beim naechsten Mal erneut */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* egal */
    }
  },
};

const round = (n) => Number(n.toFixed(COORD_DECIMALS));

function isIos() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function pushConfigured() {
  return Boolean(PUSH_URL);
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * "hidden" (kein Worker konfiguriert), "needsInstall" (iOS ausserhalb der
 * Home-Bildschirm-App), "unsupported", "denied", "off" oder "on".
 */
export async function pushStatus() {
  if (!PUSH_URL) return "hidden";
  if (!supported()) return isIos() && !isStandalone() ? "needsInstall" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    return (await currentSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/**
 * Oeffentlichen Schluessel vorab holen. Safari verlangt, dass subscribe() aus
 * einer Nutzeraktion heraus aufgerufen wird; ein Netzabruf dazwischen kann das
 * brechen. Deshalb liegt der Schluessel beim Tippen schon bereit.
 */
export async function prefetchPushKey() {
  if (!PUSH_URL || !supported()) return;
  try {
    const res = await fetch(`${PUSH_URL}/vapid`);
    if (res.ok) {
      const { publicKey } = await res.json();
      if (publicKey) store.set(KEY_STORE, publicKey);
    }
  } catch {
    /* offline: es bleibt der gespeicherte Schluessel */
  }
}

function placeKey(place) {
  return `${round(place.lat)},${round(place.lon)},${place.name}`;
}

async function postSubscribe(subscription, place) {
  const res = await fetch(`${PUSH_URL}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      place: { lat: round(place.lat), lon: round(place.lon), name: place.name },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
  if (res.status === 429) throw new Error("full");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  store.set(PLACE_STORE, placeKey(place));
}

/**
 * Regenalarm einschalten fuer `place` ({ id, lat, lon, name }; id ist "geo"
 * oder die id eines gespeicherten Ortes). Muss direkt aus dem Tipp-Handler
 * kommen: die Berechtigungsabfrage ist der erste Schritt, ohne Netz davor.
 * @returns {Promise<"on"|"denied"|"off">}
 */
export async function enablePush(place) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    let key = store.get(KEY_STORE);
    if (!key) {
      await prefetchPushKey();
      key = store.get(KEY_STORE);
    }
    if (!key) throw new Error("key");
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  try {
    await postSubscribe(sub, place);
  } catch (err) {
    // Ohne Eintrag beim Worker kaeme nie eine Mitteilung: Abo wieder loesen,
    // damit die Anzeige nicht "an" behauptet.
    await sub.unsubscribe().catch(() => {});
    store.del(PLACE_STORE);
    throw err;
  }
  store.set(OWNER_STORE, place.id);
  return "on";
}

/** Regenalarm ausschalten. Lokal wird immer abgemeldet, auch wenn der Worker nicht antwortet. */
export async function disablePush() {
  const sub = await currentSubscription();
  store.del(PLACE_STORE);
  store.del(OWNER_STORE);
  if (!sub) return;
  try {
    await fetch(`${PUSH_URL}/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    /* Worker raeumt das Abo spaetestens beim naechsten Versand auf (410) */
  }
  await sub.unsubscribe();
}

/**
 * Den Alarm nachziehen, wenn sich sein Ort geaendert hat: beim automatischen
 * Standort die Position, bei gespeicherten Orten Name oder Koordinaten. Nur
 * fuer den Ort, an dem der Alarm eingeschaltet wurde; wer bloss bei einem
 * anderen Ort nachschaut, verschiebt den Alarm nicht. Schickt nur bei einer
 * Aenderung etwas an den Worker.
 */
export async function syncPushPlace(place) {
  if (!PUSH_URL || !supported() || !place) return;
  if (store.get(OWNER_STORE) !== place.id) return;
  if (store.get(PLACE_STORE) === placeKey(place)) return;
  try {
    const sub = await currentSubscription();
    if (sub) await postSubscribe(sub, place);
  } catch {
    /* naechster erfolgreicher Radarabruf versucht es erneut */
  }
}
