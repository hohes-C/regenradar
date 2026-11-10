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

Optional: **Regenalarm** per Web Push. Dafür läuft ein kleiner Cloudflare Worker
(`push/`), der alle fünf Minuten das Radar prüft und eine Mitteilung schickt,
wenn Regen im Anmarsch ist. Die App selbst bleibt statisch; ohne Worker ist die
Funktion ausgeblendet. Einrichtung im Abschnitt
[Regenalarm (Web Push)](#regenalarm-web-push).

## Aufbau

```
index.html            App-Shell
styles.css            Light und Dark Mode über prefers-color-scheme
manifest.webmanifest  PWA-Manifest
sw.js                 Service Worker (Root, Scope "./")
src/
  config.js           alle Konstanten und Schwellen
  api.js              Bright Sky /radar und /current_weather (einziges Modul mit API-Wissen)
  alerts.js           Bright Sky /alerts -> gruppierte DWD-Warnungen
  nowcast.js          RadarSeries -> Nowcast (rein, ohne DOM, ohne Date.now())
  text.js             Nowcast -> deutsche Sätze (rein)
  places.js           gespeicherte Orte in localStorage
  ui.js               Rendering und DOM
  main.js             Bootstrap, Geolocation, Refresh-Logik
  push.js             Regenalarm: Push-Abo anlegen, abmelden, Ort nachziehen
  debug.js            erzwingt UI-Zustände, nur bei ?state= geladen
push/                 Regenalarm-Worker (Cloudflare), eigenes package.json
  src/index.js        Endpunkte und Cron-Lauf
  src/rain.js         wann alarmiert wird, Text der Mitteilung (rein)
  src/webpush.js      Web Push nur mit WebCrypto: RFC 8291 und RFC 8292
  scripts/vapid-keys.mjs  VAPID-Schlüsselpaar erzeugen
  wrangler.toml       Cron, KV-Bindung, erlaubte App-Adresse
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

Die Oberfläche verhält sich wie eine App, nicht wie ein Dokument: Textauswahl
ist per `user-select: none` abgeschaltet, sonst zog das Wischen über die
Zeitleiste eine Markierung auf und iOS blendete Auswahlgriffe und Lupe ein.
Ausgenommen sind die Fußzeile im Warnungen-Reiter und die Eingabefelder.

Unten liegt die Reiterleiste. Am Reiter *Warnungen* zeigt ein Zähler die Anzahl
der aktiven Warnungen.

Im Regen-Reiter scrollen Hero, Vorhersage- und Radar-Karte gemeinsam, auf
üblichen Telefonen ist aber alles ohne Scrollen im Bild. Dafür ist der Hero eine
flache Zeile: Wettersymbol, Kurzfassung und darunter klein der Ort mit der
aktuellen Temperatur.

Die Kartengröße folgt daraus, dass Zeitleiste und Karte zusammen sichtbar
bleiben müssen: das Wischen über die Leiste zeigt den jeweiligen Frame auf der
Karte, und daran liest man den Zug des Regens ab. Nach unten ist die Karte auf
ein etwa quadratisches Format begrenzt (`min(78vw, 340px)`), nach oben auf die
Fensterhöhe abzüglich Kopfzeile, Hero, Vorhersage-Karte und Reiterleiste; auf
hohen Fenstern wächst sie in den freien Platz.

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

Radar, Warnungen und Stationsdaten starten unabhängig voneinander nach der
Standortermittlung und verwenden dieselben Koordinaten. Der Aktualisieren-Knopf
wartet auf alle drei Abrufe. Ein Ortswechsel entwertet sämtliche Antworten der
vorherigen Aktivierung, auch beim schnellen Wechsel A → B → A. Alte Radarflächen
werden beim Wechsel auf einen Ort ohne Cache geleert.

Schlägt ein Warnungsabruf fehl, bleiben vorhandene Meldungen mit einem deutlichen
Hinweis auf den möglicherweise veralteten Stand lesbar. Eine zuvor leere Liste
wird dann als „Warnstatus unbekannt“ angezeigt, nicht als Entwarnung.

Fehlende Radarintervalle erscheinen als Datenlücken in der Zeitleiste. Aussagen
über zwei Stunden Trockenheit setzen ein vollständiges Vorhersagefenster voraus.
Die 120 Minuten des DWD beginnen am Radar-Lauf, nicht am Abrufzeitpunkt. Reichen
lückenlose Daten bis zu diesem Laufende, zeigt die App bei einem kürzeren
Restzeitraum „Kein Regen bis HH:MM“ statt „Vorhersage unvollständig“. Die
Statuszeile nennt das Vorhersageende. Leere Slots danach bleiben in der Zeitleiste
sichtbar. Fehlende Intervalle innerhalb des Laufs, Nullwerte und ein unbekannter
Laufzeitstempel werden weiterhin als Datenlücken behandelt. Alterswarnungen
bleiben unabhängig davon erhalten.
Regenereignisse werden nicht über unbekannte Intervalle verbunden. Aktueller
Regen sowie einzelne intensive Frames oberhalb von `MODERATE_MAX_MMH` bleiben
auch bei kurzer Dauer erhalten. Die Intensität berücksichtigt mindestens den
Wert der Standortzelle und wird durch trockene Nachbarn nicht herabgesetzt.
Andere isolierte Regenframes werden mit ihrer tatsächlichen Intensität benannt.

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
| `CURRENT_MAX_AGE_MIN` | 120 | ältere Beobachtungen werden nicht mehr angezeigt |
| `GEO_MAX_AGE_MS` | 300000 | maximumAge für Geolocation (beim manuellen Aktualisieren 0) |
| `GEO_TIMEOUT_MS` | 10000 | Timeout für Geolocation |
| `COORD_DECIMALS` | 3 | Rundung der Koordinaten vor der Anfrage |
| `PUSH_URL` | `""` | Adresse des Regenalarm-Workers; leer blendet die Funktion aus |
| `PUSH_ALERT_WINDOW_MIN` | 30 | Regen, der innerhalb so vieler Minuten beginnt, löst aus |
| `PUSH_COOLDOWN_MIN` | 60 | frühestens so lange nach einer Mitteilung die nächste |
| `PUSH_RADAR_DISTANCE_M` | 5000 | Radarausschnitt des Workers (11 × 11 Pixel, ohne Karte) |

Einheit der Rohwerte: Niederschlag in 0,01 mm pro 5 Minuten. Ein Frame mit
Zeitstempel T beschreibt das Intervall (T minus 5 Minuten, T]. mm/h = Wert ×
0,12.

## Regenalarm (Web Push)

Die Glocke oben rechts schaltet den Regenalarm für den Ort ein, der in der App
gerade aktiv ist. Ein Cloudflare Worker prüft dann alle fünf Minuten das Radar
und schickt eine Mitteilung, sobald Regen innerhalb von 30 Minuten beginnt,
etwa „Mäßiger Regen in 20 Minuten · Nürnberg: ab 14:35, etwa 40 Minuten.“

Aufbau nach dem Muster aus
[„Web Push für interne Dienste“](https://hetzel.net/2026-11-05/web-push-fuer-interne-dienste/):
Service Worker empfängt, die App meldet das Abo an, ein eigener Dienst
verschickt mit VAPID-Schlüssel über den Push-Dienst des Browsers. Statt eines
Go-Servers ist der Absender hier ein Cloudflare Worker mit Cron-Trigger und
KV-Speicher, und statt einer Bibliothek übernimmt WebCrypto die Verschlüsselung.
Die Entscheidung, wann es regnet, ist dieselbe Nowcast-Logik wie in der App
(`src/nowcast.js`), Alarm und Anzeige widersprechen sich also nicht.

### Einrichtung

Voraussetzungen: kostenloses Cloudflare-Konto, Node 20 oder neuer.

```sh
cd push
npm install                                   # holt Wrangler (Cloudflares CLI)
npx wrangler login
npx wrangler kv namespace create SUBS         # die ausgegebene id in wrangler.toml eintragen
node scripts/vapid-keys.mjs                   # erzeugt das Schlüsselpaar
npx wrangler secret put VAPID_PUBLIC_KEY      # Wert aus der vorigen Ausgabe
npx wrangler secret put VAPID_PRIVATE_KEY     # Wert aus der vorigen Ausgabe
npx wrangler secret put VAPID_SUBJECT         # mailto:deine@adresse oder https://deine.seite
```

In `push/wrangler.toml` bei `ALLOWED_ORIGINS` die Adresse der App eintragen
(Schema und Host ohne Pfad, z. B. `https://regen.example.com`), dann:

```sh
npx wrangler deploy                           # gibt die Adresse des Workers aus
```

Die ausgegebene Adresse (`https://regenradar-push.<konto>.workers.dev`) in
`src/config.js` bei `PUSH_URL` eintragen, **`CACHE_VERSION` in `sw.js` erhöhen**
und die App neu ausliefern. Ohne die neue Cache-Version liefert der Service
Worker weiter die alte `config.js` aus dem Cache und die Glocke bleibt aus.

Auf dem iPhone: App vom Home-Bildschirm öffnen, Glocke tippen, Mitteilungen
erlauben. Kurz darauf kommt „Regenalarm ist an“, damit ist der ganze Weg einmal
geprüft. Ein neues Schlüsselpaar macht alle bestehenden Abos ungültig; dann die
Glocke einmal aus- und wieder einschalten.

### Verhalten

- **Auslöser:** Regen, der innerhalb von `PUSH_ALERT_WINDOW_MIN` (30) Minuten
  beginnt oder gerade begonnen hat. Tendenzen jenseits von 60 Minuten lösen
  nicht aus, veraltete Radardaten auch nicht.
- **Eine Mitteilung pro Regenphase.** Danach ist Ruhe, bis es trocken ist und
  kein Regen mehr im Fenster liegt; die nächste kommt frühestens nach
  `PUSH_COOLDOWN_MIN` (60) Minuten. Ein Nowcast, der an der Schwelle flackert,
  erzeugt so keine Serie.
- **Ort:** der Ort, an dem die Glocke eingeschaltet wurde. Nur mal bei einem
  anderen Ort nachschauen verschiebt den Alarm nicht. Beim automatischen
  Standort gilt die Position, die zuletzt bei geöffneter App bestimmt wurde: Web
  Push kann den Standort nicht im Hintergrund nachverfolgen. Bewegt man sich
  mit offener App, zieht die App den Alarm nach. Für einen anderen Ort die
  Glocke aus- und dort wieder einschalten.
- **Uhrzeiten** in der Zeitzone des Geräts. Der Worker selbst läuft in UTC und
  bekommt die Zeitzone beim Abonnieren mitgeteilt.
- **Nur auf dem Home-Bildschirm:** Auf iPhone und iPad gibt es Web Push nur in
  einer Web-App, die zum Home-Bildschirm hinzugefügt wurde (ab iOS 16.4). In
  Safari selbst erklärt die Glocke das, statt nichts zu tun.

### Absicherung und Kosten

- Abos nimmt der Worker nur von der Adresse in `ALLOWED_ORIGINS` an und nur bis
  `MAX_SUBSCRIPTIONS` (10). Gesendet wird ausschließlich an die Push-Dienste von
  Apple, Google, Mozilla und Microsoft, sonst ließe sich der Worker mit einem
  erfundenen Abo als Weiterleitung missbrauchen.
- Abgelaufene Abos (`404`/`410` vom Push-Dienst) löscht der Worker. Ausnahme:
  Abos jünger als zehn Minuten. Googles Dienst meldete für ein brandneues Abo
  einmal `410`, Sekunden später kam die Zustellung an dasselbe Abo durch.
- **Gespeichert** wird bei Cloudflare je Abo: die Push-Adresse samt Schlüssel,
  der Ort auf drei Nachkommastellen gerundet (etwa 100 m), sein Name und die
  Zeitzone. Abschalten der Glocke löscht den Eintrag.
- **Kosten:** Für ein paar Geräte reicht der Gratistarif. Ein Cron-Lauf alle
  fünf Minuten sind 288 am Tag. Pro Lauf ein Radarabruf je Ort (nicht je Abo),
  ein KV-`list` und ein `get` je Abo; geschrieben wird nur, wenn sich der
  Zustand eines Abos ändert (KV erlaubt gratis 1.000 Schreibzugriffe am Tag).
- **Rechenzeit:** Der Gratistarif erlaubt 10 ms je Lauf. In Node gemessen kostet
  ein Ort etwa 0,6 ms (Radar auswerten), eine verschickte Mitteilung etwa 1,3 ms
  (Verschlüsselung und Signatur). Ein gewöhnlicher Lauf liegt damit weit
  darunter; eng wird es nur, wenn an mehreren Orten gleichzeitig Regen beginnt.
  Bricht Cloudflare einen Lauf ab, sind die bis dahin verschickten Mitteilungen
  samt Zustand gespeichert, der Rest folgt fünf Minuten später. Für mehr Geräte
  hebt der bezahlte Workers-Tarif die Grenze auf.
- Der Worker fragt Bright Sky mit `Accept-Encoding: gzip` ab. Ohne den Kopf
  lehnt Bright Sky `format=plain` mit HTTP 400 ab; Browser schicken ihn immer,
  die App ist davon nicht betroffen.

### Lokal testen

```sh
cd push
printf 'VAPID_PUBLIC_KEY=…\nVAPID_PRIVATE_KEY=…\nVAPID_SUBJECT=mailto:test@example.org\nALLOWED_ORIGINS=http://localhost:8000\n' > .dev.vars
npm run dev                                   # wrangler dev --test-scheduled, Port 8787
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # einen Cron-Lauf auslösen
```

`.dev.vars` steht in `.gitignore`. Die Tests (`npm test` im Repo-Wurzelverzeichnis)
prüfen die Verschlüsselung gegen das Beispiel aus RFC 8291, die Alarmlogik und
den Worker mit nachgebautem KV, Radar und Push-Dienst, der die Mitteilung wie ein
Browser entschlüsselt.

## App-Icon

Quelle sind die beiden SVG, die PNG werden daraus gerendert. Das Icon ist auf
die Darstellungsarten von iOS ausgelegt, vor allem auf "Getönt" und "Klar"
(Liquid Glass, ab iOS 26): dort fallen Farbton und Sättigung weg, übrig bleibt
die Helligkeit. Daraus folgt der Aufbau:

- sehr heller Tropfen (Weiß nach `#7fe1ff`) auf sehr dunklem Grund. Der Abstand
  der mittleren Helligkeit liegt bei 0,76 von 1; vorher waren es 0,46.
- eine große zusammenhängende Fläche statt dünner Linien, rund 21 % des
  Quadrats, und keine Innenzeichnung. Die frühere Glanzellipse wurde in "Klar"
  zu einem unscharfen Fleck.
- randlos, ohne eigene Eckenrundung. iOS und Android legen ihre eigene Maske
  darüber; eine mitgelieferte Rundung erzeugte darin ein zweites, sichtbares
  Quadrat.

Für Web-Apps gibt es keine getrennten Varianten für hell, dunkel, getönt und
klar, wie sie native Apps über den Asset-Katalog mitgeben. iOS bekommt genau
ein `apple-touch-icon` und leitet alle Darstellungsarten daraus ab, deshalb muss
dieses eine Bild in allen vieren tragen.

PNG nach einer Änderung an den SVG neu rendern, zum Beispiel mit librsvg:

```sh
for s in 180 192 512; do rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon-$s.png; done
rsvg-convert -w 512 -h 512 icons/icon-maskable.svg -o icons/icon-maskable-512.png
```

Jedes andere Werkzeug tut es auch, solange die Kantenlänge stimmt und die
Dateien deckend bleiben: ein `apple-touch-icon` mit transparenten Flächen
bekommt von iOS einen schwarzen Grund untergelegt.

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

## Temperatur

`/current_weather?lat=&lon=` liefert die aktuellen Messwerte der nächstgelegenen
DWD-Station. Genutzt werden die Temperatur (auf ganze Grad gerundet, neben dem
Ort) und der Stationsname als Label des automatischen Standorts. Der Aufruf
ersetzt den früheren auf `/sources`, die Zahl der Anfragen bleibt also gleich.

Der Wert ist dekorativ: `fetchCurrentWeather` wirft nie, bei jedem Fehler kommt
`null` zurück und die Temperatur wird schlicht nicht angezeigt. Beobachtungen,
die älter als `CURRENT_MAX_AGE_MIN` sind, werden ebenfalls nicht angezeigt: die
Stationen melden stündlich, ein deutlich älterer Wert wäre irreführend.

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
`/current_weather` (nächstgelegene DWD-Station, z. B. "Berlin-Alexanderplatz"),
zusammen mit der Temperatur. Selbst angelegte Orte behalten den eingegebenen
Namen, bekommen die Temperatur aber genauso.

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

