# Regenradar

Statische mobile PWA für Safari auf dem iPhone. Zwei Reiter:

- **Regen** beantwortet eine Frage: Wann regnet es hier in den nächsten 120
  Minuten und wie stark. Kurzfassung als Überschrift, darunter eine Zeitleiste
  (per Wischen abtastbar) und eine Radar-Karte des Niederschlags um den Standort
  (aus den DWD-Daten gezeichnet, über einem OpenStreetMap-Kachelhintergrund).
  Datenbasis ist der DWD-Radar-Nowcast (Produkt RV).
- **Warnungen** zeigt die amtlichen DWD-Warnmeldungen für die Warnzelle des
  Ortes, gruppiert nach Ereignisart und mit der Warnstufe 1 bis 4. Ein Tippen
  auf eine Zeile klappt Überschrift und Verhaltenshinweis auf.

Beides über die [Bright-Sky-API](https://brightsky.dev/).

Kein Backend, kein Framework, kein Bundler, keine Laufzeitabhängigkeiten. Plain
HTML, CSS und ES-Module. Die App spricht direkt mit `api.brightsky.dev` und lädt
Kartenkacheln von `tile.openstreetmap.org`.

## Aufbau

```
index.html            App-Shell
styles.css            Light und Dark Mode über prefers-color-scheme
manifest.webmanifest  PWA-Manifest
sw.js                 Service Worker (Root, Scope "./")
src/
  config.js           alle Konstanten und Schwellen
  api.js              Bright Sky /radar -> RadarSeries (einziges Modul mit API-Wissen)
  alerts.js           Bright Sky /alerts -> gruppierte DWD-Warnungen
  nowcast.js          RadarSeries -> Nowcast (rein, ohne DOM, ohne Date.now())
  text.js             Nowcast -> deutsche Sätze (rein)
  places.js           gespeicherte Orte in localStorage
  ui.js               Rendering und DOM
  main.js             Bootstrap, Geolocation, Refresh-Logik
  debug.js            erzwingt UI-Zustände, nur bei ?state= geladen
icons/                icon.svg, icon-maskable.svg, PNG in 180/192/512 px
scripts/explore.mjs   Erkundungsskript (Schritt 0)
tests/                Node-Testrunner, keine Testbibliothek
NOTES.md              Erkundungsergebnisse gegen die Bright-Sky-API
```

Datenfluss strikt getrennt: nur `api.js` kennt das Antwortformat von Bright Sky.
Für Stufe 2 (eigenes Backend) genügt es, `API_BASE` umzustellen.

## Lokale Entwicklung

Node 20 oder neuer. ES-Module brauchen einen HTTP-Server, `file://` reicht nicht.

```sh
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

`localhost` gilt als sicherer Kontext, daher funktionieren dort Geolocation und
Service Worker auch ohne HTTPS. Vom Telefon aus zählt das nicht, siehe unten.

### Tests

```sh
npm test           # entspricht: node --test
```

Deckt `nowcast.js`, `text.js` und `api.js` ab (reine Logik und Normalisierung,
kein DOM, kein Netz). Hinweis: `node --test tests/` mit Verzeichnis-Argument
schlägt unter Node 26 fehl; `npm test` (Auto-Discovery) oder
`node --test 'tests/*.test.js'` verwenden.

### Erkundung der API neu ausführen

```sh
npm run explore    # ruft Bright Sky für einen Beispielort (Berlin), schreibt tests/fixtures/raw-sample.json
```

### UI-Zustände erzwingen

Über den URL-Parameter `?state=` lässt sich jeder Zustand ohne Netz zeigen:

`loading`, `ok`, `rainNow`, `stale`, `veryStale`, `error`, `offline`, `noGeo`,
`noCoverage` sowie `alerts` und `alertsEmpty` für den Warnungen-Reiter.
Beispiel: `http://localhost:8000/?state=veryStale`. Der Debug-Pfad
(`src/debug.js`) wird nur bei gesetztem Parameter dynamisch geladen und kostet im
Normalbetrieb nichts.

## Oberfläche

Ein Farbschema, dunkles Violett mit Verlauf, bewusst ohne Light-Mode-Variante:
so wirken die Radarfarben überall gleich. Runde Systemschrift (`ui-rounded`, auf
iOS SF Pro Rounded), Inhalte in halbtransparenten Karten mit kleiner
Versalien-Kopfzeile. Symbole sind Inline-SVG im Dokument (`<symbol>` plus
`<use>`), es werden keine Schrift- oder Bilddateien nachgeladen.

Unten liegt die Reiterleiste. Am Reiter *Warnungen* zeigt ein Zähler die Anzahl
der aktiven Warnungen.

Im Regen-Reiter scrollen Hero, Vorhersage- und Radar-Karte gemeinsam. Die
Kartengröße folgt daraus, dass Zeitleiste und Karte zusammen ins Bild passen
müssen: das Wischen über die Leiste zeigt den jeweiligen Frame auf der Karte,
und daran liest man den Zug des Regens ab. Nach unten ist die Karte deshalb auf
ein etwa quadratisches Format begrenzt (`min(78vw, 380px)`), nach oben auf die
Fensterhöhe abzüglich Kopfzeile, Reiterleiste und Vorhersage-Karte; auf hohen
Fenstern wächst sie in den freien Platz.

Das DWD-Raster wird formatfüllend gezeichnet und am Standort ausgerichtet, der
dadurch immer exakt in der Kartenmitte sitzt. Die Orts-Auswahl und das Formular
zum Anlegen eines Ortes kommen als Blatt über die Seite, damit sie das Layout
nicht sprengen.

## Bedienung und Aktualisierung

Der Knopf oben rechts aktualisiert alles in einem Schritt: neue
Standortbestimmung (`maximumAge: 0`, also keine gecachte Position), neue
Radardaten und Warnungen am HTTP-Cache vorbei (`cache: "no-store"`) und eine
Neuberechnung der Anzeige gegen die aktuelle Uhr. Der Ring dreht sich, solange
das läuft.

Radar und Warnungen werden getrennt geladen: ein Fehler in der einen Abfrage
lässt die andere Ansicht stehen.

Unabhängig davon rechnet die App die Anzeige alle `CLOCK_MS` gegen die Uhr neu
und ebenso, sobald sie wieder sichtbar wird. Ohne das hingen "jetzt", die
Zeitleiste und die Ticks bis zur nächsten erfolgreichen Netz-Abfrage an der
Uhrzeit des letzten Abrufs. Die Statuszeile zeigt neben dem Zeitstempel des
DWD-Laufs ("Stand") auch, wann zuletzt abgerufen wurde.

## Konfiguration

Alle Werte in `src/config.js`. Schwellen und Fenster nur dort ändern, nie hart
im Code.

| Konstante | Wert | Bedeutung |
|---|---|---|
| `API_BASE` | `https://api.brightsky.dev` | später auf eigenes Backend umstellbar |
| `DISTANCE_M` | 20000 | Ausschnitt für Karte und Nowcast, ergibt ~41 × 41 Pixel (~40 km) |
| `PAST_MIN` | 30 | Historie in der Anfrage |
| `HORIZON_MIN` | 120 | Vorhersagefenster |
| `FRAME_MIN` | 5 | Länge eines Frames |
| `MMH_PER_UNIT` | 0.12 | 0,01 mm pro 5 min in mm/h |
| `RAIN_MIN_MMH` | 0.3 | darunter gilt Rauschen, also trocken |
| `LIGHT_MAX_MMH` | 2.5 | bis hier "leicht" |
| `MODERATE_MAX_MMH` | 10 | bis hier "mäßig" |
| `STRONG_MAX_MMH` | 50 | bis hier "stark", darüber "sehr stark" |
| `NEAR_WINDOW` | 3 | Nachbarschaft in Pixeln bis 60 min Vorlauf |
| `FAR_WINDOW` | 5 | Nachbarschaft ab 60 min Vorlauf |
| `UNCERTAIN_AFTER_MIN` | 60 | ab hier gilt ein Frame als Tendenz |
| `MIN_EVENT_FRAMES` | 2 | kürzere Regenphasen sind Ausreißer |
| `MAX_GAP_FRAMES` | 1 | so viele trockene Frames überbrückt ein Ereignis |
| `STALE_MIN` | 15 | Datenalter, ab dem gewarnt wird |
| `VERY_STALE_MIN` | 30 | Datenalter, ab dem die Vorhersage als unbrauchbar gilt |
| `REFRESH_MS` | 300000 | Intervall für neue Netz-Abfragen bei sichtbarer App |
| `CLOCK_MS` | 30000 | Intervall, in dem die Anzeige gegen die Uhr neu gerechnet wird |
| `MIN_REFETCH_MS` | 300000 | jüngere Ergebnisse werden nicht neu geladen |
| `FETCH_TIMEOUT_MS` | 10000 | Timeout einer Anfrage |
| `GEO_MAX_AGE_MS` | 300000 | maximumAge für Geolocation (beim manuellen Aktualisieren 0) |
| `GEO_TIMEOUT_MS` | 10000 | Timeout für Geolocation |
| `COORD_DECIMALS` | 3 | Rundung der Koordinaten vor der Anfrage |

Einheit der Rohwerte: Niederschlag in 0,01 mm pro 5 Minuten. Ein Frame mit
Zeitstempel T beschreibt das Intervall (T minus 5 Minuten, T]. mm/h = Wert ×
0,12.

## Deployment

Beliebiges statisches Hosting mit HTTPS. Wichtig: `sw.js`, `manifest.webmanifest`
und `index.html` müssen im selben Verzeichnis (Scope `./`) liegen. Es gibt keinen
Build-Schritt, das Repo wird unverändert ausgeliefert.

**Geolocation und Service Worker brauchen HTTPS.** `localhost` ist die einzige
Ausnahme und gilt nur auf dem Entwicklungsrechner selbst, nicht vom Telefon aus.

### Caddy

```caddy
regen.example.com {
    root * /var/www/regenradar
    file_server
    encode gzip
    header /sw.js Cache-Control "no-cache"
}
```

Caddy stellt HTTPS automatisch aus. `no-cache` für `sw.js` sorgt dafür, dass ein
neuer Service Worker zuverlässig erkannt wird.

### Cloudflare Pages oder GitHub Pages

Repo verbinden, Build-Command leer lassen, Output-Verzeichnis auf das Repo-Root
(`/`) setzen. Beide liefern HTTPS und damit funktionieren Geolocation und PWA.

### Nach Änderungen an der App-Shell

`CACHE_VERSION` in `sw.js` erhöhen (z. B. `regenradar-v2`). Der Service Worker
löscht dann beim Aktivieren alle alten Caches. API-Antworten von Bright Sky
werden nie gecacht.

## Test auf dem iPhone

`localhost` erreicht das Telefon nicht. Entweder früh auf ein statisches HTTPS-
Hosting deployen oder den lokalen Server über einen HTTPS-Tunnel verfügbar machen
(Tailscale Serve oder cloudflared). Danach in Safari über "Zum Home-Bildschirm"
installieren; die App startet im Vollbild.

## Warnungen

`/alerts?lat=&lon=` liefert die amtlichen DWD-Warnungen (CAP) für die Warnzelle
der Koordinaten. `severity` wird auf die DWD-Warnstufe abgebildet:

| CAP-Severity | Stufe | Bezeichnung |
| --- | --- | --- |
| `minor` | 1 | Wetterwarnung |
| `moderate` | 2 | Markantes Wetter |
| `severe` | 3 | Unwetterwarnung |
| `extreme` | 4 | Extremes Unwetter |

Als Warnzellenname wird `name_short` bevorzugt: `name` ist der amtliche Name
und wird lang ("Mitgliedsgemeinde in Verwaltungsgemeinschaft Adelshofen"), die
Kurzform lautet dann "Adelshofen/AN". Der volle Name bleibt als `title` am
Element erhalten, und die Zeile bricht um, statt abgeschnitten zu werden.

Der DWD gibt dieselbe Warnung für jede betroffene Warnzelle einzeln aus.
`normalizeAlerts` fasst Meldungen mit gleicher Ereignisart, Stufe, Zeitspanne
und gleichem Text zu einer zusammen und gruppiert danach nach Ereignisart
(absteigend nach Warnstufe).

Nicht enthalten sind die Gesundheits- und Umweltindizes der DWD-WarnWetter-App
(Pollen, Biowetter, UV-Index, Bodenfeuchte, Brandgefahr). Die kommen aus einem
eigenen DWD-Dienst, den Bright Sky nicht anbietet.

## Datenquelle

Bright Sky liefert das DWD-Radarkomposit RV: Niederschlag auf einem 1-km-Raster
in 5-Minuten-Schritten, Vorhersage bis +120 Minuten, alle 5 Minuten neu. Kein
API-Key, CORS offen. Fair Use: höchstens eine Anfrage pro Ort und 5 Minuten;
keine Anfragen, solange die App nicht sichtbar ist (beides in `main.js`
umgesetzt).

Der Ortsname des automatischen Standorts kommt aus dem Bright-Sky-Endpoint
`/sources` (nächstgelegene DWD-Station, z. B. "Berlin-Alexanderplatz"). Selbst
angelegte Orte behalten den eingegebenen Namen.

### Kartenhintergrund

Hinter dem Radar liegen Kacheln von OpenStreetMap (`tile.openstreetmap.org`,
Web-Mercator, an der Standortkoordinate verankert und auf die 1-km-Rasterskala
gebracht). Das ist ein bewusster Fremd-Request: Beim Laden geht der
Kartenausschnitt – und damit näherungsweise der Standort – an die OSM-Tile-Server.
Attribution "© OpenStreetMap" ist eingeblendet (OSM-Tile-Usage-Policy). Der
Service Worker cacht die Kacheln nicht; offline bleibt der Hintergrund leer, das
Radar funktioniert weiter. Der metrische Maßstab unten links ist rasterbasiert
und bleibt exakt (1 Zelle = 1 km), unabhängig vom Kartenhintergrund.

Datenbasis: Deutscher Wetterdienst, via Bright Sky.
