import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encryptPayload,
  vapidAuthorization,
  generateVapidKeys,
  b64urlEncode,
  b64urlDecode,
  p256Jwk,
} from "../push/src/webpush.js";

// Beispiel aus RFC 8291, Abschnitt 5: feste Schluessel und fester Salt ergeben
// genau diesen Rumpf. Prueft die Verschluesselung gegen die Norm statt gegen
// eine eigene Entschluesselung, die denselben Fehler haben koennte.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcSenderKeys() {
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const raw = b64urlDecode(RFC.asPublic);
  return {
    publicKey: await crypto.subtle.importKey("raw", raw, ecdh, true, []),
    privateKey: await crypto.subtle.importKey("jwk", p256Jwk(raw, RFC.asPrivate), ecdh, false, ["deriveBits"]),
  };
}

test("RFC 8291: Beispielnachricht ergibt exakt den Rumpf aus der Norm", async () => {
  const body = await encryptPayload({
    payload: RFC.plaintext,
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
    salt: b64urlDecode(RFC.salt),
    senderKeys: await rfcSenderKeys(),
  });
  assert.equal(b64urlEncode(body), RFC.body);
  // Kopf 16 + 4 + 1 + 65 = 86 Byte, Klartext 41 + 1 Trennbyte, Tag 16 Byte.
  // Das Beispiel der Norm nennt "Content-Length: 145", sein eigener Rumpf
  // dekodiert aber auf diese 144 Byte; die Angabe im Beispiel stimmt nicht.
  assert.equal(body.length, 144);
  assert.equal(b64urlDecode(RFC.body).length, 144);
});

test("Verschluesselung: ohne feste Werte jedes Mal ein anderer Rumpf", async () => {
  const args = { payload: "x", p256dh: RFC.uaPublic, auth: RFC.auth };
  const a = b64urlEncode(await encryptPayload(args));
  const b = b64urlEncode(await encryptPayload(args));
  assert.notEqual(a, b); // neuer Salt und neuer Absenderschluessel pro Nachricht
});

test("Verschluesselung: kaputte Empfaengerschluessel und zu lange Nachricht werden abgewiesen", async () => {
  await assert.rejects(encryptPayload({ payload: "x", p256dh: "AAAA", auth: RFC.auth }), /p256dh/);
  await assert.rejects(encryptPayload({ payload: "x", p256dh: RFC.uaPublic, auth: "AAAA" }), /auth/);
  await assert.rejects(
    encryptPayload({ payload: "x".repeat(4096), p256dh: RFC.uaPublic, auth: RFC.auth }),
    /zu lang/
  );
});

test("VAPID: Token ist gueltig signiert und traegt Ursprung, Ablauf und Absender", async () => {
  const keys = await generateVapidKeys();
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const header = await vapidAuthorization({
    endpoint: "https://web.push.apple.com/QGuQ-abc?x=1",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: "mailto:regen@example.org",
    now,
  });

  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const [, h, c, sig, k] = m;
  assert.equal(k, keys.publicKey);

  const dec = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
  assert.deepEqual(dec(h), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(dec(c), { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "mailto:regen@example.org" });

  const pub = await crypto.subtle.importKey(
    "raw",
    b64urlDecode(keys.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pub,
    b64urlDecode(sig),
    new TextEncoder().encode(`${h}.${c}`)
  );
  assert.equal(ok, true);
});

test("VAPID: Absender ohne mailto: oder https: wird abgelehnt (Apple verlangt das)", async () => {
  const keys = await generateVapidKeys();
  await assert.rejects(
    vapidAuthorization({ endpoint: "https://fcm.googleapis.com/x", ...keys, subject: "regen@example.org" }),
    /VAPID_SUBJECT/
  );
});

test("Schluesselpaar: oeffentlich 65 Byte unkomprimiert, privat 32 Byte", async () => {
  const keys = await generateVapidKeys();
  const pub = b64urlDecode(keys.publicKey);
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  assert.equal(b64urlDecode(keys.privateKey).length, 32);
});
