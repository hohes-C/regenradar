// Neues VAPID-Schluesselpaar erzeugen. Einmalig vor dem ersten Deploy; ein
// neues Paar macht alle bestehenden Abos ungueltig.
//
//   node scripts/vapid-keys.mjs
//
// Die Werte dann als Secrets hinterlegen (siehe README, Abschnitt Regenalarm).

import { generateVapidKeys } from "../src/webpush.js";

const { publicKey, privateKey } = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
