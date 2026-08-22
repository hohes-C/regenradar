// Schritt 0, Erkundung. Ruft Bright Sky fuer einen Beispielort (Berlin) auf und meldet die
// Struktur der Antwort, damit die Annahmen aus dem Plan geprueft werden koennen.
// Speichert die Rohantwort nach tests/fixtures/raw-sample.json.
//
// Aufruf: node scripts/explore.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_BASE = "https://api.brightsky.dev";
const LAT = 52.52;
const LON = 13.405;
const DISTANCE_M = 2000;
const PAST_MIN = 30;
const HORIZON_MIN = 120;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "tests", "fixtures");
const fixturePath = join(fixtureDir, "raw-sample.json");

function iso(date) {
  // ISO-8601 in UTC, ohne Millisekunden.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildUrl(now) {
  const date = new Date(now.getTime() - PAST_MIN * 60_000);
  const lastDate = new Date(now.getTime() + (HORIZON_MIN + 5) * 60_000);
  const params = new URLSearchParams({
    lat: String(LAT),
    lon: String(LON),
    distance: String(DISTANCE_M),
    format: "plain",
    date: iso(date),
    last_date: iso(lastDate),
  });
  return `${API_BASE}/radar?${params.toString()}`;
}

function dims(grid) {
  if (!Array.isArray(grid)) return "kein Array";
  const rows = grid.length;
  const cols = Array.isArray(grid[0]) ? grid[0].length : "n/a";
  return `${rows} x ${cols}`;
}

function scanValues(grid, acc) {
  if (!Array.isArray(grid)) return;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const v of row) {
      if (v === null || v === undefined) {
        acc.nulls += 1;
        continue;
      }
      if (typeof v !== "number") continue;
      acc.count += 1;
      if (v < 0) acc.negative += 1;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
    }
  }
}

async function main() {
  const now = new Date();
  const url = buildUrl(now);
  console.log("Jetzt (UTC):", iso(now));
  console.log("URL:", url);
  console.log();

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    console.error("Netzwerkfehler:", err.message);
    process.exitCode = 1;
    return;
  }
  const bodyText = await res.text();
  const t1 = performance.now();

  const elapsedMs = Math.round(t1 - t0);
  const bytes = Buffer.byteLength(bodyText, "utf8");

  console.log("HTTP-Status:", res.status, res.statusText);
  console.log("Antwortzeit:", elapsedMs, "ms");
  console.log("Antwortgroesse:", bytes, "Bytes", `(${(bytes / 1024).toFixed(1)} KiB)`);
  console.log();

  if (!res.ok) {
    console.error("Fehlerantwort:", bodyText.slice(0, 500));
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    console.error("JSON-Parsefehler:", err.message);
    process.exitCode = 1;
    return;
  }

  const records = Array.isArray(data.radar) ? data.radar : [];
  console.log("Anzahl Records:", records.length);
  console.log();

  console.log("Top-Level-Schluessel:", Object.keys(data).join(", "));
  console.log("geometry:", JSON.stringify(data.geometry));
  console.log("latlon_position:", JSON.stringify(data.latlon_position));
  console.log("bbox:", JSON.stringify(data.bbox));
  console.log();

  const acc = { count: 0, negative: 0, nulls: 0, min: Infinity, max: -Infinity };
  const sources = new Set();

  console.log("Records:");
  records.forEach((rec, i) => {
    const grid = rec.precipitation_5;
    const gridIsNull = grid === null;
    scanValues(grid, acc);
    sources.add(rec.source);
    const show = i < 3 || i >= records.length - 2;
    if (show) {
      console.log(
        `  [${String(i).padStart(2, "0")}] timestamp=${rec.timestamp}` +
          ` dim=${gridIsNull ? "null" : dims(grid)}` +
          ` source=${rec.source}`
      );
    } else if (i === 3) {
      console.log("  ...");
    }
  });
  console.log();

  console.log("Werte gesamt (nicht-null):", acc.count);
  console.log("Fehlwerte (null):", acc.nulls);
  console.log("negative Werte:", acc.negative);
  console.log("min:", acc.min === Infinity ? "n/a" : acc.min);
  console.log("max:", acc.max === -Infinity ? "n/a" : acc.max);
  console.log();

  // Quantile fuer eine Vorstellung der Verteilung.
  const flat = [];
  for (const rec of records) {
    if (!Array.isArray(rec.precipitation_5)) continue;
    for (const row of rec.precipitation_5) {
      if (!Array.isArray(row)) continue;
      for (const v of row) if (typeof v === "number") flat.push(v);
    }
  }
  flat.sort((a, b) => a - b);
  const q = (p) => (flat.length ? flat[Math.floor((flat.length - 1) * p)] : "n/a");
  console.log("Verteilung: p50=%s p90=%s p99=%s", q(0.5), q(0.9), q(0.99));
  console.log();

  // Ableitung des Vorhersage-Laufs aus source, falls moeglich.
  const runTimes = [];
  for (const rec of records) {
    const m = typeof rec.source === "string" && rec.source.match(/(\d{4}-\d{2}-\d{2}T[\d:+-]+)$/);
    if (m) runTimes.push(m[1]);
  }
  const uniqueRunTimes = [...new Set(runTimes)];
  console.log("Zeitstempel aus source (unique):", uniqueRunTimes.length);
  uniqueRunTimes.slice(0, 5).forEach((t) => console.log("  ", t));
  if (records.length) {
    console.log("erster record timestamp:", records[0].timestamp);
    console.log("letzter record timestamp:", records[records.length - 1].timestamp);
  }

  // Beispiel-Grid des ersten Records mit Daten.
  const firstWithData = records.find((r) => Array.isArray(r.precipitation_5));
  if (firstWithData) {
    console.log();
    console.log("Beispiel-Grid (erster Record mit Daten):");
    for (const row of firstWithData.precipitation_5) console.log("  ", JSON.stringify(row));
  }

  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixturePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log();
  console.log("Rohantwort gespeichert:", fixturePath);
}

main();
