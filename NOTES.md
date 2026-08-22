# Erkundungsergebnisse, Schritt 0

Quelle: `node scripts/explore.mjs`, Abfrage für einen Beispielort in Deutschland
(Berlin, 52.52, 13.405), `distance=2000`, `format=plain`, `date=jetzt-30min`,
`last_date=jetzt+125min`. Rohantwort: `tests/fixtures/raw-sample.json`.

## Antworten auf die fünf offenen Fragen

### 1. Enthält `source` den Zeitstempel des Vorhersage-Laufs?

Ja, exakt wie im Plan erwartet.

- `source` hat das Format `RADARCOMP::RV::<ISO-Zeitstempel>`.
  (Nicht `RADOLAN::RV::` wie im Plan-Beispiel, sondern `RADARCOMP::RV::`.)
- Analyse-Records (`timestamp <= Lauf`): `source`-Zeitstempel == eigener `timestamp`.
- Vorhersage-Records (`timestamp > Lauf`): `source`-Zeitstempel == Lauf, für alle gleich.

**Folgerung:** `runTime = max(source-Zeitstempel über alle Records)`. Das Datenalter
ist `now - runTime`. `isForecast = timestamp > runTime`. Die Ableitung in `api.js`
zieht den Zeitstempel per String hinter dem letzten `::` aus `source` und prüft
kein festes Präfix.

### 2. Wie viele Records, akzeptiert `date` eine Uhrzeit?

- 30 Records bei `date=jetzt-30min`, `last_date=jetzt+125min`.
- Aufteilung im Beispiel: 6 Analyse-Records, 24 Vorhersage-Records (bis Lauf + 120 min).
- `date` akzeptiert einen vollen ISO-Zeitstempel mit Uhrzeit. Bright Sky rastert auf
  das 5-Minuten-Gitter. Das Vorhersagefenster endet bei Lauf + 120 min, auch wenn
  `last_date` weiter reicht.
- Konsequenz: `HORIZON_MIN=120` liefert die Frames Lauf+5..Lauf+120. Die Anzahl der
  Analyse-Records hängt vom `date`-Offset ab (`PAST_MIN=30`).

### 3. Array-Dimension und `latlon_position`

- Dimension: **5 × 5** bei `distance=2000`, wie erwartet. Alle Records gleich.
- `latlon_position` liefert Bruchzahlen, nullbasiert (Beispiel `{x: 1.502, y: 2.26}`).
  - `x` = Spalten-Index, `y` = Zeilen-Index. Ursprung oben links (Zeile 0 = erste Zeile).
  - **Zentrum in `api.js`:** `row = round(y)`, `col = round(x)`, hier `[2][2]`.
- `geometry`: Polygon mit den vier Eckkoordinaten des Ausschnitts.
- `bbox`: Indizes im DWD-Gesamtraster (5 Zellen je Richtung). Für die App nicht nötig.

### 4. Kodierung fehlender Daten

- In der Beispielantwort: **keine** Fehlwerte. Alle Zellen belegt, 0 `null`, 0 negativ.
- Trocken ist als `0` kodiert, nicht als `null`.
- Fehlwert-Kodierung ließ sich empirisch **nicht** auslösen (der Ort liegt mitten im
  Raster). Bright-Sky-Doku nennt `null` für außerhalb des Rasters bzw. fehlende Zellen.
- **Beibehaltene Strategie in `api.js`:** negative Werte → `null`, `precipitation_5 === null`
  (ganzer Record) → Record überspringen, einzelne `null`-Zellen → `null` im Grid.

### 5. Antwortzeit und Antwortgröße

- Antwortzeit: rund 200 bis 350 ms.
- Antwortgröße: rund 5 KiB für ~30 Records im 5×5-Raster, `format=plain`.
- CORS: laut Doku offen; im Browser (Schritt 3) bestätigt, die App fragt direkt ab.

## Auswirkungen auf den Plan

Keine strukturelle Abweichung nötig. Zwei kleine Präzisierungen:

1. `source`-Präfix ist `RADARCOMP::RV::`, nicht `RADOLAN::RV::`. Der Parser liest nur
   den Zeitstempel hinter dem letzten `::`.
2. `latlon_position`: `x` = Spalte, `y` = Zeile, nullbasiert, Ursprung oben links.
   Zentrum per Rundung; Fallback ist die Array-Mitte, falls `latlon_position` fehlt.

Alle Annahmen aus Abschnitt 2 und 3 des Plans sind bestätigt.
