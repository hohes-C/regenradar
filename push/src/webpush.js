// Web Push ohne Bibliothek, nur mit WebCrypto: Verschluesselung der Nutzlast
// nach RFC 8291 (aes128gcm) und Absender-Ausweis nach RFC 8292 (VAPID).
// Laeuft unveraendert im Cloudflare Worker und in Node 20+ (Tests).

const enc = new TextEncoder();

// Groesse eines Datensatzes. Unsere Nachrichten sind kurz und passen immer in
// einen; laengere wuerden mehrere Datensaetze brauchen, das unterstuetzen wir nicht.
const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;

export function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/**
 * Oeffentlicher P-256-Schluessel (65 Byte, unkomprimiert: 0x04 || x || y) als
 * JWK, optional mit privatem Anteil `d`. WebCrypto kann private EC-Schluessel
 * nicht roh importieren, nur als JWK mit allen drei Koordinaten.
 */
export function p256Jwk(rawPublic, d) {
  if (rawPublic.length !== 65 || rawPublic[0] !== 4) {
    throw new Error("Oeffentlicher Schluessel ist kein unkomprimierter P-256-Punkt");
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(rawPublic.slice(1, 33)),
    y: b64urlEncode(rawPublic.slice(33, 65)),
    ext: true,
  };
  if (d) jwk.d = d;
  return jwk;
}

/**
 * RFC 8291: Nutzlast fuer einen Empfaenger verschluesseln. Liefert den fertigen
 * Rumpf (Kopf mit Salt, Datensatzgroesse und Absenderschluessel, dann Chiffrat).
 * `salt` und `senderKeys` nur fuer Tests; sonst bei jedem Aufruf neu und zufaellig.
 */
export async function encryptPayload({ payload, p256dh, auth, salt, senderKeys }) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh ungueltig");
  if (authSecret.length !== 16) throw new Error("auth ungueltig");

  const plain = typeof payload === "string" ? enc.encode(payload) : payload;
  if (plain.length + 1 + TAG_LENGTH > RECORD_SIZE) throw new Error("Nachricht zu lang fuer einen Datensatz");

  const keys = senderKeys ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256)
  );
  salt ??= crypto.getRandomValues(new Uint8Array(16));

  // HKDF in den Einzelschritten aus RFC 8291, Abschnitt 3.4. Jede Ableitung
  // braucht nur einen Block, deshalb genuegt je ein HMAC mit angehaengtem 0x01.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(keyInfo, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);

  // Einziger und damit letzter Datensatz: Trennbyte 0x02, keine Fuellung.
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plain, Uint8Array.of(2)))
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, cipher);
}

/**
 * RFC 8292: Authorization-Header fuer einen Push-Endpunkt. Der Token gilt fuer
 * den Ursprung des Endpunkts und laeuft nach `ttlSec` ab; Apple lehnt Tokens
 * ab, die laenger als einen Tag gelten oder deren `sub` keine mailto:- oder
 * https:-Adresse ist.
 */
export async function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = Date.now(), ttlSec = 12 * 3600 }) {
  if (!/^(mailto:|https:)/.test(subject ?? "")) throw new Error("VAPID_SUBJECT muss mit mailto: oder https: beginnen");
  const aud = new URL(endpoint).origin;
  const part = (obj) => b64urlEncode(enc.encode(JSON.stringify(obj)));
  const signingInput = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud,
    exp: Math.floor(now / 1000) + ttlSec,
    sub: subject,
  })}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(b64urlDecode(publicKey), privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCrypto liefert die Signatur schon als r || s (64 Byte), wie JWS es will.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${publicKey}`;
}

/**
 * Eine Nachricht an ein Abo senden. `gone` heisst: das Abo existiert beim
 * Push-Dienst nicht mehr (404/410) und kann geloescht werden.
 */
export async function sendNotification({ subscription, payload, vapid, ttl = 1800, urgency = "high", fetchImpl = fetch }) {
  const body = await encryptPayload({ payload, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization({ endpoint: subscription.endpoint, ...vapid }),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 };
}

/** Neues VAPID-Schluesselpaar: oeffentlich als 65 Byte, privat als `d`, beides base64url. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateKey: d };
}
