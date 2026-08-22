# Regenradar Nowcast PWA, Stufe 1

Plan für einen Coding-Agenten. Enthält Kontext, Spezifikation, Arbeitsschritte und Abnahmekriterien. Bitte in der angegebenen Reihenfolge abarbeiten. Nach Schritt 0 anhalten und die Erkundungsergebnisse melden, bevor Anwendungscode entsteht.

## 1. Kontext und Ziel

Eine statische mobile Web App (PWA) für Safari auf dem iPhone. Sie nimmt den aktuellen Standort oder einen gespeicherten Ort, holt den Radar-Nowcast des Deutschen Wetterdienstes über die Bright-Sky-API und beantwortet eine Frage: Wann regnet es hier in den nächsten 120 Minuten und wie stark. Ein Screen, keine Karte.

Nutzer: eine Person, Eigenbedarf. Sprache der Oberfläche: Deutsch. Region: Deutschland. Das DWD-Raster deckt Deutschland und die Grenzregionen ab.

### Nicht-Ziele in Stufe 1

- Kein eigenes Backend, kein Server-Code. Die App spricht direkt mit api.brightsky.dev.
- Keine Karte, kein Push, keine Accounts, keine Analytics.
- Kein Framework, kein Bundler, keine npm-Laufzeitabhängigkeiten. Plain HTML, CSS, ES-Module.

### Stufe 2 zur Orientierung, nicht bauen

Später kommt ein eigener Dienst auf einem Homeserver, der das DWD-RV-Produkt selbst parst, dazu Push und ein Scriptable-Widget. Deshalb Datenquelle und Auswertung strikt trennen: Nur `api.js` darf wissen, wie Bright Sky antwortet. `API_BASE` muss später auf das eigene Backend zeigen können.

## 2. Datenquelle

Bright Sky, Endpoint `GET https://api.brightsky.dev/radar`. Liefert das DWD-Radarkomposit RV: Niederschlag auf einem 1-km-Raster in 5-Minuten-Schritten, Vorhersage bis +120 Minuten, alle 5 Minuten neu. Kein API-Key. CORS ist für alle Origins erlaubt, die Abfrage läuft direkt aus dem Browser.

Parameter, die wir nutzen:

- `lat`, `lon`: Standort. Der Punkt liegt im mittleren Pixel des zurückgegebenen Ausschnitts.
- `distance=2000`: Ausschnitt reicht 2000 m in jede Richtung. Erwartet werden 5 × 5 Pixel.
- `format=plain`: `precipitation_5` kommt als verschachteltes Integer-Array (Zeilen × Spalten).
- `date`: ISO-8601-Zeitstempel des ersten Records. Wir setzen jetzt minus 30 Minuten.
- `last_date`: ISO-8601-Zeitstempel des letzten Records. Wir setzen jetzt plus 125 Minuten.
- `tz` lassen wir weg. Zeitstempel kommen in UTC und werden im Client lokal formatiert.

Antwortstruktur laut Bright-Sky-Doku:

```json
{
  "radar": [
    {
      "timestamp": "2023-05-09T11:05:00+00:00",
      "source": "RADOLAN::RV::2023-05-09T11:05:00+00:00",
      "precipitation_5": [[0, 0, 3, 12, 5], "..."]
    }
  ],
  "geometry": {},
  "latlon_position": {}
}
```

Einheiten: Ein Wert ist Niederschlag in 0,01 mm pro 5 Minuten. Ein Frame mit `timestamp` T beschreibt das Intervall (T minus 5 Minuten, T]. Umrechnung in mm/h: `wert * 0.12`. Wert 45 entspricht 5,4 mm/h.

Fair Use: höchstens eine Anfrage pro Ort und 5 Minuten. Keine Anfragen, solange die App nicht sichtbar ist. API-Antworten im Service Worker nie cachen.

Quellenvermerk in der App: "Datenbasis: Deutscher Wetterdienst, via Bright Sky".

Wenn Bright Sky nicht erreichbar ist, gibt es in Stufe 1 keine Ersatzquelle. Die App muss dann sauber mit dem letzten gespeicherten Ergebnis und einer Fehlermeldung umgehen.

## 3. Offene Fragen, die Schritt 0 klären muss

Die Annahmen in diesem Plan sind aus der Doku abgeleitet und müssen empirisch bestätigt werden. Ergebnisse in `NOTES.md` festhalten.

1. Enthält `source` den Zeitstempel des Vorhersage-Laufs? Erwartung: Analyse-Records haben `timestamp` gleich Lauf, Vorhersage-Records `timestamp` größer Lauf. Wenn ja, ist das Maximum der Lauf-Zeitstempel über alle Records der aktuelle Lauf, und das Datenalter ist jetzt minus Lauf.
2. Wie viele Records kommen mit unseren `date` und `last_date` Werten? Akzeptiert `date` eine Uhrzeit, nicht nur ein Datum?
3. Exakte Dimension des Arrays bei `distance=2000`. Erwartung 5 × 5 mit dem Standort in `[2][2]`. Was bedeutet `latlon_position` genau: relativ zum Ausschnitt oder zum Gesamtraster, ist x die Spalte und y die Zeile, wo liegt der Ursprung?
4. Wie werden fehlende Daten kodiert: negative Werte, `null`, 0? Gibt es Records mit `precipitation_5: null`?
5. Antwortzeit und Antwortgröße mit `format=plain` bei dieser Ausschnittgröße.

## 4. Projektstruktur

```
regenradar/
  index.html
  styles.css
  manifest.webmanifest
  sw.js                  muss im Root liegen, Scope "./"
  src/
    config.js            alle Konstanten, siehe Abschnitt 5
    api.js               Bright Sky -> RadarSeries, einziges Modul mit API-Wissen
    nowcast.js           RadarSeries -> Nowcast, rein, ohne DOM und ohne Date.now()
    text.js              Nowcast -> deutsche Sätze, rein
    places.js            gespeicherte Orte in localStorage
    ui.js                Rendering, Events
    main.js              Bootstrap, Refresh-Logik
  icons/                 icon.svg, PNG in 180, 192 und 512 px
  scripts/
    explore.mjs          Schritt 0
  tests/
    fixtures/            raw-sample.json aus Schritt 0, synthetische Serien
    nowcast.test.js
    text.test.js
    api.test.js
  README.md
  NOTES.md
```

Tests laufen mit dem eingebauten Node-Testrunner: `node --test tests/`. Node 20 oder neuer. Keine Testbibliothek installieren.

## 5. Konfiguration in `config.js`

Alle Werte als benannte, exportierte Konstanten. Im README dokumentieren.

| Konstante | Wert | Bedeutung |
|---|---|---|
| `API_BASE` | `https://api.brightsky.dev` | später auf eigenes Backend umstellbar |
| `DISTANCE_M` | 2000 | Ausschnitt, ergibt 5 × 5 Pixel |
| `PAST_MIN` | 30 | Historie in der Anfrage |
| `HORIZON_MIN` | 120 | Vorhersagefenster |
| `FRAME_MIN` | 5 | Länge eines Frames |
| `MMH_PER_UNIT` | 0.12 | 0,01 mm pro 5 min in mm/h |
| `RAIN_MIN_MMH` | 0.3 | darunter gilt Rauschen, also trocken |
| `LIGHT_MAX_MMH` | 2.5 | bis hier "leicht" |
| `MODERATE_MAX_MMH` | 10 | bis hier "mäßig" |
| `STRONG_MAX_MMH` | 50 | bis hier "stark", darüber "sehr stark" |
| `NEAR_WINDOW` | 3 | Nachbarschaft in Pixeln (Kantenlänge) bis 60 min Vorlauf |
| `FAR_WINDOW` | 5 | Nachbarschaft ab 60 min Vorlauf |
| `UNCERTAIN_AFTER_MIN` | 60 | ab hier gilt ein Frame als Tendenz |
| `MIN_EVENT_FRAMES` | 2 | kürzere Regenphasen sind Ausreißer |
| `MAX_GAP_FRAMES` | 1 | so viele trockene Frames überbrückt ein Ereignis |
| `STALE_MIN` | 15 | Datenalter, ab dem gewarnt wird |
| `VERY_STALE_MIN` | 30 | Datenalter, ab dem die Vorhersage als unbrauchbar gilt |
| `REFRESH_MS` | 300000 | Intervall bei sichtbarer App |
| `MIN_REFETCH_MS` | 300000 | jüngere Ergebnisse werden nicht neu geladen |
| `FETCH_TIMEOUT_MS` | 10000 | |
| `GEO_MAX_AGE_MS` | 300000 | maximumAge für Geolocation |
| `GEO_TIMEOUT_MS` | 10000 | |
| `COORD_DECIMALS` | 3 | Rundung der Koordinaten vor der Anfrage |

## 6. Modul `api.js`

`fetchRadarSeries({ lat, lon, now, fetchImpl })` gibt `Promise<RadarSeries>` zurück.

- Baut die URL nach Abschnitt 2. `fetchImpl` ist für Tests injizierbar, Standard ist `globalThis.fetch`.
- AbortController mit `FETCH_TIMEOUT_MS`.
- Fehler werden als `ApiError` mit `kind` unterschieden: `network`, `timeout`, `http` (mit Status), `empty` (kein Record), `shape` (Array nicht wie erwartet).
- Normalisiert in:

```js
/** @typedef {{
 *   fetchedAt: Date,
 *   runTime: Date | null,          // aus source, null wenn nicht ableitbar
 *   center: { row: number, col: number },
 *   frames: Array<{
 *     validTime: Date,
 *     grid: (number|null)[][],     // null = keine Daten
 *     isForecast: boolean          // validTime > runTime
 *   }>
 * }} RadarSeries */
```

- Fehlwerte (negative Werte oder was Schritt 0 als Fehlwert identifiziert) werden zu `null`. Records mit `precipitation_5` gleich `null` werden übersprungen.
- `center` aus `latlon_position`, sobald die Semantik aus Schritt 0 klar ist, sonst Mitte des Arrays. Ist das Array kleiner als `FAR_WINDOW` × `FAR_WINDOW`, wird ein `shape`-Fehler geworfen.
- Frames nach `validTime` aufsteigend sortieren, Duplikate nach `validTime` entfernen, der letzte gewinnt.

Test `api.test.js`: parst `tests/fixtures/raw-sample.json` über ein gemocktes `fetchImpl` und prüft Anzahl, Sortierung, Zentrum, Fehlwerte und `runTime`. Fehlerklassen mit gemockten Antworten testen: Timeout, HTTP 500, leeres Array, falsche Dimension, ungültiges JSON.

## 7. Modul `nowcast.js`

`computeNowcast(series, now, config)` gibt ein `Nowcast` zurück. Rein, deterministisch, keine Seiteneffekte. `now` wird übergeben, nie intern ermittelt.

Ablauf:

1. **Frames einteilen.** `current` ist der letzte Frame mit `validTime <= now`. `forecast` sind die Frames mit `validTime > now`, höchstens `HORIZON_MIN / FRAME_MIN` Stück. `past` sind die übrigen Frames mit `validTime <= now` für die optionale Historienleiste.
2. **Datenalter.** `ageMin` ist `(now - series.runTime)` in Minuten. Ist `runTime` null, dann `ageMin = now - current.validTime` und `ageUncertain = true`. `freshness` ist `fresh`, `stale` (ab `STALE_MIN`) oder `veryStale` (ab `VERY_STALE_MIN`).
3. **Vorlauf pro Frame.** `leadMin` ist die Zeit von `now` bis zum Beginn des Frame-Intervalls, also `(validTime - FRAME_MIN - now)` in Minuten, auf ganze Minuten gerundet, mindestens 0. `uncertain = leadMin > UNCERTAIN_AFTER_MIN`.
4. **Nachbarschaftswerte pro Frame.** Fenster `NEAR_WINDOW` bei `leadMin <= UNCERTAIN_AFTER_MIN`, sonst `FAR_WINDOW`, zentriert auf `center`, am Rand abschneiden. `null` ignorieren. Sind alle Werte `null`, ist der Frame `noData`. Ergebnis: `maxMmh` und `medianMmh`, beide schon in mm/h.
5. **Regen ja/nein.** `isRain = maxMmh >= RAIN_MIN_MMH`.
6. **Intensität.** Basis ist `medianMmh`. Wenn `isRain` und `medianMmh < RAIN_MIN_MMH`, dann `rateMmh = RAIN_MIN_MMH`, also mindestens "leicht". Sonst `rateMmh = medianMmh`. Kategorie aus `rateMmh`: `none`, `light`, `moderate`, `strong`, `extreme` nach den Schwellen in config. Obergrenzen inklusive, also 2,5 ist noch `light`.
7. **Glätten und Ereignisse bilden.** Über die Folge `[current, ...forecast]`: zusammenhängende Regen-Frames zu Ereignissen zusammenfassen, wobei bis zu `MAX_GAP_FRAMES` trockene Frames innerhalb eines Ereignisses überbrückt werden. Ereignisse mit weniger als `MIN_EVENT_FRAMES` Regen-Frames werden verworfen, die betroffenen Frames bekommen `isolated = true`. Sie fließen als "vereinzelt Tropfen möglich" in den Text ein, starten aber kein Ereignis.
8. **Ereignis-Objekt.**

```js
{
  start: Date,            // validTime des ersten Regen-Frames minus FRAME_MIN
  end: Date,              // validTime des letzten Regen-Frames
  startsNow: boolean,     // current gehört dazu
  openEnded: boolean,     // reicht bis zum Ende des Fensters
  durationMin: number,
  peakMmh: number, peakTime: Date, peakCategory: string,
  sumMm: number,          // Summe rateMmh / 12 über die Regen-Frames
  uncertain: boolean      // Start nach UNCERTAIN_AFTER_MIN
}
```

9. **Fenster.** Für 10, 20 und `HORIZON_MIN` Minuten: `{ maxMmh, category, firstRainAt: Date | null }` über alle Frames mit `leadMin` kleiner als die Fensterlänge. Hier zählen Regen-Frames unabhängig von der Ereignisbildung, damit ein Ausreißer direkt vor der Haustür nicht verschwindet.
10. **Rückgabe.**

```js
{
  now, runTime, ageMin, ageUncertain,
  freshness,                         // 'fresh' | 'stale' | 'veryStale'
  coverage,                          // 'ok' | 'partial' | 'none' (none: alle Frames noData)
  current, forecast, past,           // Frames mit allen berechneten Feldern
  events,                            // Event[]
  windows: { m10, m20, m120 },
  isolatedFrames                     // Frame[]
}
```

Tests in `nowcast.test.js` mit einem Fixture-Builder `buildSeries(centerValues, options)`, der aus einer Liste von Zentrumswerten pro Frame eine `RadarSeries` baut. Optionen: Nachbarwerte (0 oder gleich dem Zentrum), `runOffsetMin`, `nullCells`. Mindestens diese Fälle:

- komplett trocken
- Regen jetzt, endet nach 35 Minuten
- trocken, Regen beginnt in 30 Minuten, Dauer 25 Minuten
- zwei getrennte Schauer
- ein einzelner Regen-Frame: Ausreißer, kein Ereignis, `isolated` gesetzt, taucht trotzdem im 10-Minuten-Fenster auf
- ein trockener Frame innerhalb einer Regenphase: wird überbrückt, bleibt ein Ereignis
- Regen nur im Zentrum, Nachbarn trocken: `isRain` über das Maximum, Intensität mindestens `light`
- Regen nur ab +75 Minuten: `uncertain`, Fenster 5 × 5 aktiv
- Lauf 20 Minuten alt (`stale`), Lauf 40 Minuten alt (`veryStale`)
- `null` in der Nachbarschaft, und ein Frame komplett ohne Daten (`coverage: 'partial'`)
- alle Frames ohne Daten (`coverage: 'none'`)
- `runTime` null, Fallback greift, `ageUncertain`
- Kategoriegrenzen exakt bei 2,5, 10 und 50 mm/h
- Ereignis reicht bis zum Fensterende (`openEnded`)

## 8. Modul `text.js`

`summarize(nowcast)` gibt `{ headline, detail, status }` zurück, alle Strings, `detail` darf `null` sein. Rein, deutsch. Zahlen mit `Intl.NumberFormat('de-DE')`, Uhrzeiten als `HH:MM` lokal. Keine Gedankenstriche in UI-Texten.

Regeln für `headline`, erste zutreffende Zeile gewinnt:

| Lage | Text |
|---|---|
| `coverage` ist `none` | "Keine Radardaten für diesen Ort." |
| kein Ereignis, keine isolierten Frames | "Kein Regen in den nächsten 2 Stunden." |
| kein Ereignis, isolierte Frames | "Weitgehend trocken, vereinzelt Tropfen möglich gegen {HH:MM}." |
| Ereignis läuft, `openEnded` | "Es regnet gerade, {kategorie} ({rate} mm/h). Hält voraussichtlich die nächsten 2 Stunden an." |
| Ereignis läuft, endet im Fenster | "Es regnet gerade, {kategorie} ({rate} mm/h). Lässt voraussichtlich gegen {end} nach." |
| nächstes Ereignis beginnt in unter 3 Minuten | "Gleich {kategorie}er Regen bis {peak} mm/h, etwa {dauer} Minuten." |
| nächstes Ereignis beginnt in 3 bis 30 Minuten | "Trocken, in {n} Minuten {kategorie}er Regen bis {peak} mm/h, etwa {dauer} Minuten." |
| nächstes Ereignis beginnt nach 30 Minuten | "Trocken bis etwa {start}, dann {kategorie}er Regen bis {peak} mm/h, etwa {dauer} Minuten." |

Zusätze:

- Ereignis `uncertain`: "Tendenz:" voranstellen und "möglicherweise" einbauen. Beispiel: "Tendenz: ab etwa 16:30 möglicherweise leichter Regen."
- Ereignis `openEnded` und nicht laufend: Dauer als "mindestens {dauer} Minuten".
- Weitere Ereignisse landen in `detail`: "Weiterer Schauer gegen {start}, {kategorie}." Bei mehr als zwei Ereignissen: "Wechselhaft, {n} Schauer bis {HH:MM}."
- Laufendes Ereignis mit anschließender Trockenphase: `detail` "Danach trocken bis {HH:MM}." oder "Danach trocken."
- `status`: "Stand {HH:MM}" bei `fresh`, "Daten {n} Minuten alt" bei `stale`, "Daten veraltet ({n} Minuten), Vorhersage unsicher" bei `veryStale`. Bei `ageUncertain` den Zusatz "(geschätzt)" anhängen.

Kategorie-Wörter: leicht, mäßig, stark, sehr stark. Adjektivform vor "Regen": leichter, mäßiger, starker, sehr starker. Rate mit einer Nachkommastelle unter 10 mm/h, sonst ganzzahlig. `{rate}` ist `rateMmh` des aktuellen Frames, `{peak}` ist `peakMmh` des Ereignisses.

Tests in `text.test.js`: für jeden Fall aus `nowcast.test.js` die erwartete Headline als exakter String, dazu `status` für alle drei `freshness`-Werte.

## 9. Oberfläche

Ein Screen, von oben nach unten:

1. **Ortszeile.** Ortsname oder "Aktueller Standort", rechts ein Refresh-Button. Darunter klein der `status` aus `text.js`.
2. **Headline.** Groß, maximal drei Zeilen. Darunter `detail`, falls vorhanden.
3. **Zeitleiste.** 24 Segmente à 5 Minuten für die Vorhersage-Frames. Farbe nach Kategorie, Höhe nach `rateMmh`, gedeckelt bei 10 mm/h. Frames mit `uncertain` in 60 % Deckkraft. Unter der Leiste Uhrzeit-Ticks alle 30 Minuten, links die Markierung "jetzt". Optional links davon 6 gedämpfte Segmente für die letzten 30 Minuten aus `past`, durch eine senkrechte Linie getrennt. `noData`-Frames grau schraffiert.
4. **Drei Kacheln.** "10 Min", "20 Min", "2 Std". Jede mit Ampelfarbe und Text: "trocken" oder "{kategorie} ab {HH:MM}" plus `maxMmh`. Nie nur Farbe, immer auch Text.
5. **Orte.** Chips: "Standort", dann gespeicherte Orte, dann "+". Aktiver Chip hervorgehoben.
6. **Fußzeile.** "Datenbasis: Deutscher Wetterdienst, via Bright Sky".

Farben für Kategorien, jeweils für Light und Dark Mode über `prefers-color-scheme`:

- `none`: neutrales Grau
- `light`: helles Blau
- `moderate`: mittleres Blau
- `strong`: dunkles Blau bis Violett
- `extreme`: Magenta

Gestaltung zurückhaltend und systemnah. Systemschrift über `-apple-system`, Schriftgrößen mindestens 16 px, Tap-Ziele mindestens 44 px. Kein Layout-Sprung beim Laden: Platzhalter in den finalen Höhen.

Zustände:

- `loading`: Platzhalter, Spinner nur im Refresh-Button.
- `ok`: normale Darstellung.
- `stale` und `veryStale`: Statuszeile gelb bzw. rot, Inhalt bleibt sichtbar.
- `error`: Fehlertext je nach `ApiError.kind` plus Button "Erneut versuchen". Das letzte gültige Ergebnis bleibt stehen, mit Hinweis "Stand HH:MM".
- `offline`: wie `error`, Text "Offline".
- `noGeo`: Standort verweigert oder fehlgeschlagen. Hinweis anzeigen und auf den zuletzt aktiven gespeicherten Ort zurückfallen.
- `noCoverage`: außerhalb des DWD-Rasters, Text aus `text.js`.

Alle Zustände müssen zum Testen erzwingbar sein, entweder über einen URL-Parameter wie `?state=error` oder über ein eingebautes Fixture. Dieser Debug-Pfad darf im normalen Betrieb nichts kosten.

## 10. Orte und Standort in `places.js` und `main.js`

- `navigator.geolocation.getCurrentPosition` mit `enableHighAccuracy: false`, `maximumAge: GEO_MAX_AGE_MS`, `timeout: GEO_TIMEOUT_MS`. Kein `watchPosition`.
- Geolocation funktioniert nur in sicherem Kontext, also HTTPS oder localhost.
- Koordinaten auf `COORD_DECIMALS` Stellen runden, bevor sie in die URL gehen.
- Gespeicherte Orte in `localStorage` unter `regenradar.places` als JSON-Array `{ id, name, lat, lon }`. Aktiver Ort unter `regenradar.activePlace`, Wert `"geo"` oder eine `id`.
- "+" öffnet ein kleines Formular: Name, dann entweder "aktuelle Position übernehmen" oder lat/lon manuell. Löschen über einen Bearbeiten-Modus. Einfach halten.
- Letztes Ergebnis pro Ort in `localStorage` unter `regenradar.last.<id>` ablegen, inklusive `fetchedAt`. Beim Öffnen sofort rendern, dann frisch laden.

Refresh-Logik:

- Laden beim Start, beim Ortswechsel, bei `visibilitychange` auf sichtbar, und per `setInterval(REFRESH_MS)`, solange die Seite sichtbar ist. Bei `hidden` das Interval löschen.
- Keine Anfrage, wenn das letzte Ergebnis für denselben gerundeten Ort jünger als `MIN_REFETCH_MS` ist. Der Refresh-Button umgeht diese Sperre.
- Während eine Anfrage läuft, keine zweite starten.

## 11. PWA

`manifest.webmanifest`: `name` "Regenradar", `short_name` "Regen", `display` "standalone", `start_url` "./", `scope` "./", `background_color` und `theme_color` passend zum Design, Icons in 192 und 512 px, zusätzlich eine Variante mit `purpose: "maskable"`.

Head von `index.html`:

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, im Dark Mode `black-translucent` prüfen
- `<link rel="apple-touch-icon" href="icons/icon-180.png">`
- `<meta name="theme-color">` je einmal für Light und Dark über das `media`-Attribut
- Safe-Area-Insets in CSS über `env(safe-area-inset-*)`

`sw.js`:

- Versionierter Cache-Name, zum Beispiel `regenradar-v1`. Bei jeder Änderung an der App-Shell die Version hochzählen.
- Precache der App-Shell: `index.html`, `styles.css`, alle Dateien unter `src/`, `manifest.webmanifest`, Icons.
- Fetch-Strategie: App-Shell cache-first. Alles unter `api.brightsky.dev` network-only, nie cachen, keine Fallback-Antwort aus dem Cache.
- `activate`: alte Caches löschen, dann `skipWaiting` und `clients.claim`.

Icons: `icons/icon.svg` als Vorlage mit einem einfachen Regentropfen-Motiv. Daraus PNG in 180, 192 und 512 px mit einem vorhandenen Systemwerkzeug erzeugen (rsvg-convert oder ImageMagick). Dafür keine npm-Abhängigkeit ins Projekt holen.

## 12. Arbeitsschritte und Abnahme

**Schritt 0, Erkundung.** `scripts/explore.mjs` schreiben. Das Skript ruft Bright Sky für einen Beispielort in Deutschland (Berlin, 52.52, 13.405) mit den Parametern aus Abschnitt 2 auf und gibt aus: Anzahl Records, pro Record `timestamp` und `source`, Array-Dimension, `latlon_position`, Minimum und Maximum der Werte, Anzahl negativer Werte, Antwortzeit und Antwortgröße. Rohantwort nach `tests/fixtures/raw-sample.json` speichern. Die fünf Fragen aus Abschnitt 3 in `NOTES.md` beantworten. Danach anhalten und die Ergebnisse melden. Wenn die Annahmen nicht stimmen, vor allem bei Frage 1 und 3, wird dieser Plan angepasst, bevor Anwendungscode entsteht.

**Schritt 1, Logik.** `config.js`, `nowcast.js`, `text.js` mit Tests. Abnahme: `node --test tests/` grün, alle Fälle aus Abschnitt 7 und 8 abgedeckt, keine DOM- und keine Netzwerkzugriffe in diesen Modulen.

**Schritt 2, Datenzugriff.** `api.js` mit `api.test.js` gegen das Fixture. Abnahme: Fixture wird korrekt in `RadarSeries` überführt, alle Fehlerklassen getestet.

**Schritt 3, Oberfläche.** `index.html`, `styles.css`, `ui.js`, `main.js`, noch ohne Orte-Verwaltung, Standort zum Testen fest aus config. Abnahme: läuft unter `localhost` mit einem statischen Server, zeigt Headline, Zeitleiste und Kacheln. Alle Zustände aus Abschnitt 9 sind erzwingbar und sehen sauber aus. Light und Dark Mode geprüft.

**Schritt 4, Orte und Refresh.** `places.js`, Geolocation, Refresh-Logik, localStorage. Abnahme: Ortswechsel, Speichern und Löschen funktionieren, das letzte Ergebnis erscheint beim Öffnen sofort, bei verborgenem Tab gibt es kein Polling (im Netzwerk-Tab prüfen).

**Schritt 5, PWA.** Manifest, Service Worker, Icons. Abnahme: installierbar über "Zum Home-Bildschirm" in Safari, startet im Vollbild, App-Shell lädt offline mit sinnvoller Offline-Meldung, API-Antworten landen nicht im Cache, Cache-Versionierung funktioniert.

**Schritt 6, Doku.** `README.md` mit Zweck, Konfiguration, lokaler Entwicklung und Deployment: statisches Hosting mit HTTPS, ein Beispiel-Snippet für Caddy, Hinweis auf Cloudflare Pages oder GitHub Pages, Hinweis, dass Geolocation HTTPS braucht. `NOTES.md` mit den Erkundungsergebnissen bleibt im Repo.

## 13. Test auf dem iPhone

Geolocation und Service Worker brauchen HTTPS. `localhost` zählt nur auf dem Entwicklungsrechner selbst, nicht vom Telefon aus. Für den Test auf dem Telefon entweder früh auf ein statisches Hosting mit HTTPS deployen oder den lokalen Server über einen HTTPS-Tunnel erreichbar machen (Tailscale Serve oder cloudflared). Spätestens ab Schritt 4 wird auf dem Telefon getestet.

## 14. Regeln für die Umsetzung

- Keine Frameworks, kein Bundler, keine Laufzeitabhängigkeiten, keine CDN-Skripte. Dev-Dependencies nur, wenn unbedingt nötig, und dann mit Begründung.
- ES-Module, moderne Browser-APIs ohne Polyfills. Zielbrowser: Safari auf iOS 17 oder neuer.
- `Date.now()` und `new Date()` ohne Argument nur in `main.js`. `nowcast.js` und `text.js` bekommen `now` übergeben.
- Kein Tracking, keine externen Requests außer Bright Sky.
- UI-Texte auf Deutsch ohne Gedankenstriche. Code-Bezeichner auf Englisch. Kommentare sparsam, nur wo das Warum nicht offensichtlich ist.
- Schwellen und Fenster nur über `config.js` ändern, nie hart im Code.
- Jede Abweichung von diesem Plan kurz begründen, nicht stillschweigend abweichen.

## 15. Definition of done für Stufe 1

- Auf dem iPhone installiert, startet im Vollbild, zeigt innerhalb von 3 Sekunden nach dem Öffnen ein Ergebnis, gecacht oder frisch.
- Headline, Zeitleiste und Kacheln stimmen an einem Regentag plausibel mit der WarnWetter-App überein.
- Alle Tests grün, alle Zustände aus Abschnitt 9 geprüft.
- Das README erlaubt einem Dritten, die App in 15 Minuten zu deployen.
