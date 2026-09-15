// Reine Auswertung: RadarSeries -> Nowcast. Kein DOM, kein Netz, kein Date.now().
// `now` wird immer uebergeben, nie intern ermittelt. Deterministisch und
// seiteneffektfrei; alle Schwellen kommen aus `config`.

const MIN = 60_000;

/**
 * @typedef {{
 *   validTime: Date, grid: (number|null)[][], isForecast: boolean,
 *   leadMin: number, uncertain: boolean, noData: boolean,
 *   maxMmh: number, medianMmh: number, rateMmh: number,
 *   isRain: boolean, category: string, isolated: boolean
 * }} Frame
 */

/** Ordnet eine Rate in mm/h einer Kategorie zu. Obergrenzen inklusive. */
export function categorize(mmh, c) {
  if (mmh < c.RAIN_MIN_MMH) return "none";
  if (mmh <= c.LIGHT_MAX_MMH) return "light";
  if (mmh <= c.MODERATE_MAX_MMH) return "moderate";
  if (mmh <= c.STRONG_MAX_MMH) return "strong";
  return "extreme";
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Sammelt die nicht-null Werte einer quadratischen Nachbarschaft um `center`.
// Am Rand wird abgeschnitten. `hadNull` meldet fehlende Zellen im Fenster.
function extractWindow(grid, center, win) {
  const r = Math.floor(win / 2);
  const rows = Array.isArray(grid) ? grid.length : 0;
  const values = [];
  let hadNull = false;
  for (let y = center.row - r; y <= center.row + r; y++) {
    if (y < 0 || y >= rows) continue;
    const row = grid[y];
    if (!Array.isArray(row)) continue;
    for (let x = center.col - r; x <= center.col + r; x++) {
      if (x < 0 || x >= row.length) continue;
      const v = row[x];
      if (v === null || v === undefined) {
        hadNull = true;
        continue;
      }
      values.push(v);
    }
  }
  return { values, hadNull };
}

// Berechnet alle abgeleiteten Felder eines Frames.
function computeFrame(frame, now, center, c) {
  // Vorlauf bis zum Beginn des Frame-Intervalls (validTime - FRAME_MIN).
  const leadRaw = (frame.validTime.getTime() - c.FRAME_MIN * MIN - now.getTime()) / MIN;
  const leadMin = Math.max(0, Math.round(leadRaw));
  const uncertain = leadMin > c.UNCERTAIN_AFTER_MIN;
  const win = leadMin <= c.UNCERTAIN_AFTER_MIN ? c.NEAR_WINDOW : c.FAR_WINDOW;

  const { values, hadNull } = extractWindow(frame.grid, center, win);
  const noData = values.length === 0;

  const maxUnit = noData ? 0 : Math.max(...values);
  const maxMmh = maxUnit * c.MMH_PER_UNIT;
  const medianMmh = noData ? 0 : median(values) * c.MMH_PER_UNIT;

  const isRain = !noData && maxMmh >= c.RAIN_MIN_MMH;
  let rateMmh;
  if (!isRain) rateMmh = medianMmh;
  else if (medianMmh < c.RAIN_MIN_MMH) rateMmh = c.RAIN_MIN_MMH; // mindestens "leicht"
  else rateMmh = medianMmh;
  // Ein intensiver Treffer direkt am Standort darf nicht im Median verschwinden.
  const centerUnit = frame.grid?.[center.row]?.[center.col];
  if (typeof centerUnit === "number") rateMmh = Math.max(rateMmh, centerUnit * c.MMH_PER_UNIT);

  return {
    validTime: frame.validTime,
    grid: frame.grid,
    isForecast: frame.isForecast,
    leadMin,
    uncertain,
    noData,
    hadNull,
    maxMmh,
    medianMmh,
    rateMmh,
    isRain,
    category: categorize(rateMmh, c),
    isolated: false,
  };
}

// Fasst zusammenhaengende Regen-Frames zu Ereignissen zusammen. Bis zu
// MAX_GAP_FRAMES trockene Frames werden ueberbrueckt. Cluster mit weniger als
// MIN_EVENT_FRAMES Regen-Frames sind Ausreisser und werden als `isolated`
// markiert statt ein Ereignis zu starten.
function buildEvents(seq, hasCurrent, c) {
  const rainIdx = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].isRain && !seq[i].noData) rainIdx.push(i);
  }

  const clusters = [];
  for (const idx of rainIdx) {
    const last = clusters.at(-1);
    const previous = last?.at(-1);
    const gap = previous === undefined ? [] : seq.slice(previous + 1, idx);
    const elapsed = previous === undefined ? Infinity :
      seq[idx].validTime - seq[previous].validTime;
    if (last && elapsed <= (c.MAX_GAP_FRAMES + 1) * c.FRAME_MIN * MIN &&
        gap.every((f) => !f.noData && !f.hadNull)) last.push(idx);
    else clusters.push([idx]);
  }

  const events = [];
  const isolatedFrames = [];
  for (const cluster of clusters) {
    const currentRain = hasCurrent && cluster[0] === 0;
    const intense = cluster.some((i) => seq[i].rateMmh > c.MODERATE_MAX_MMH);
    if (cluster.length < c.MIN_EVENT_FRAMES && !currentRain && !intense) {
      for (const i of cluster) {
        seq[i].isolated = true;
        isolatedFrames.push(seq[i]);
      }
      continue;
    }
    const first = cluster[0];
    const lastRain = cluster.at(-1);
    const rainFrames = cluster.map((i) => seq[i]);
    const start = new Date(seq[first].validTime.getTime() - c.FRAME_MIN * MIN);
    const end = seq[lastRain].validTime;

    let peak = rainFrames[0];
    for (const f of rainFrames) if (f.rateMmh > peak.rateMmh) peak = f;

    const sumMm = rainFrames.reduce((s, f) => s + f.rateMmh / 12, 0);

    events.push({
      start,
      end,
      startsNow: hasCurrent && first === 0,
      openEnded: lastRain === seq.length - 1 || seq[lastRain + 1].noData || seq[lastRain + 1].hadNull,
      durationMin: Math.round((end.getTime() - start.getTime()) / MIN),
      peakMmh: peak.rateMmh,
      peakTime: peak.validTime,
      peakCategory: peak.category,
      sumMm,
      uncertain: seq[first].uncertain,
    });
  }
  return { events, isolatedFrames };
}

// Kennwerte fuer ein Zeitfenster ueber alle Frames mit leadMin < maxLead.
function windowStat(frames, maxLead, c) {
  let maxMmh = 0;
  let firstRainAt = null;
  for (const f of frames) {
    if (f.leadMin >= maxLead || f.noData) continue;
    if (f.maxMmh > maxMmh) maxMmh = f.maxMmh;
    if (f.isRain && firstRainAt === null) {
      firstRainAt = new Date(f.validTime.getTime() - c.FRAME_MIN * MIN);
    }
  }
  return { maxMmh, category: categorize(maxMmh, c), firstRainAt };
}

/**
 * @param {import('./api.js').RadarSeries} series
 * @param {Date} now
 * @param {typeof import('./config.js').CONFIG} config
 */
export function computeNowcast(series, now, config) {
  const c = config;
  const center = series.center;
  const runTime = series.runTime ?? null;

  const sorted = [...series.frames].sort(
    (a, b) => a.validTime.getTime() - b.validTime.getTime()
  );
  const computed = sorted.map((f) => computeFrame(f, now, center, c));

  const atOrBefore = computed.filter((f) => f.validTime.getTime() <= now.getTime());
  const after = computed.filter((f) => f.validTime.getTime() > now.getTime());
  const latest = atOrBefore.at(-1);
  const current = latest && now - latest.validTime < c.FRAME_MIN * MIN ? latest : null;
  const past = atOrBefore.length ? atOrBefore.slice(0, -1) : [];
  // Explizite Zeitslots: fehlende Frames bleiben sichtbar und stauchen die
  // Zeitleiste nicht. Slots nach dem Ende des Radar-Laufs bleiben ebenfalls leer.
  const step = c.FRAME_MIN * MIN;
  const anchor = sorted[0]?.validTime.getTime() ?? now.getTime();
  const first = anchor + (Math.floor((now.getTime() - anchor) / step) + 1) * step;
  const byTime = new Map(after.map((f) => [f.validTime.getTime(), f]));
  const forecast = [];
  const emptyGrid = sorted[0]?.grid.map(row => row.map(() => null)) ?? [[null]];
  for (let t = first; t - step < now.getTime() + c.HORIZON_MIN * MIN; t += step) {
    forecast.push(byTime.get(t) ?? computeFrame({
      validTime: new Date(t), grid: emptyGrid, isForecast: true,
    }, now, center, c));
  }

  // Datenalter.
  let ageMin = null;
  let ageUncertain = false;
  if (runTime) {
    ageMin = Math.round((now.getTime() - runTime.getTime()) / MIN);
  } else if (current) {
    ageUncertain = true;
    ageMin = Math.round((now.getTime() - current.validTime.getTime()) / MIN);
  }
  let freshness = "fresh";
  if (ageMin !== null) {
    if (ageMin >= c.VERY_STALE_MIN) freshness = "veryStale";
    else if (ageMin >= c.STALE_MIN) freshness = "stale";
  }

  // Abdeckung ueber die dargestellten Frames (current + forecast).
  const shown = current ? [current, ...forecast] : [...forecast];
  // Der DWD-Horizont beginnt am Lauf, nicht an der aktuellen Uhrzeit.
  // Nur dieses bekannte Laufende darf fehlende Slots am Ende erklaeren.
  // Fehlende Records innerhalb des Laufs bleiben echte Datenluecken.
  const runEnd = runTime ? runTime.getTime() + c.HORIZON_MIN * MIN : null;
  const forecastUntil = forecast.findLast((f) => !f.noData)?.validTime ?? null;
  const shortened = runEnd !== null && runEnd > now.getTime() &&
    runEnd < now.getTime() + c.HORIZON_MIN * MIN &&
    forecastUntil !== null && forecastUntil.getTime() === runEnd;
  const expected = shortened
    ? shown.filter((f) => f.validTime.getTime() <= runEnd)
    : shown;
  let coverage = "ok";
  if (shown.length === 0 || shown.every((f) => f.noData)) coverage = "none";
  else if (!current || expected.some((f) => f.noData || f.hadNull)) coverage = "partial";
  else if (shortened) coverage = "shortened";

  // Ereignisse ueber [current, ...forecast].
  const seq = current ? [current, ...forecast] : [...forecast];
  const { events, isolatedFrames } = buildEvents(seq, current !== null, c);

  const windows = {
    m10: windowStat(seq, 10, c),
    m20: windowStat(seq, 20, c),
    m120: windowStat(seq, c.HORIZON_MIN, c),
  };

  return {
    now,
    runTime,
    ageMin,
    ageUncertain,
    freshness,
    coverage,
    forecastUntil,
    center,
    coords: series.coords ?? null,
    current,
    forecast,
    past,
    events,
    windows,
    isolatedFrames,
  };
}

