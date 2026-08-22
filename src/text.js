// Nowcast -> deutsche Saetze. Rein, ohne DOM. Zahlen im de-DE-Format,
// Uhrzeiten als HH:MM in lokaler Zeit. Keine Gedankenstriche in UI-Texten.

const MIN = 60_000;

// Kategorie-Woerter. WORD = Grundform, ADJ = Adjektiv vor "Regen".
const WORD = { light: "leicht", moderate: "mäßig", strong: "stark", extreme: "sehr stark" };
const ADJ = {
  light: "leichter",
  moderate: "mäßiger",
  strong: "starker",
  extreme: "sehr starker",
};

const timeFmt = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Lokale Uhrzeit als HH:MM. */
export function hhmm(date) {
  return timeFmt.format(date);
}

/** Rate in mm/h: eine Nachkommastelle unter 10, sonst ganzzahlig. de-DE. */
export function fmtRate(mmh) {
  const digits = mmh < 10 ? 1 : 0;
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(mmh);
}

/** Grundform des Kategorie-Worts fuer die UI. */
export function categoryLabel(category) {
  return WORD[category] ?? "";
}

function minutesUntil(date, now) {
  return Math.round((date.getTime() - now.getTime()) / MIN);
}

function durationPhrase(event) {
  const kind = event.openEnded ? "mindestens" : "etwa";
  return `${kind} ${event.durationMin} Minuten`;
}

function buildDetail(nowcast) {
  const events = nowcast.events;
  if (events.length > 2) {
    const lastEnd = events[events.length - 1].end;
    return `Wechselhaft, ${events.length} Schauer bis ${hhmm(lastEnd)}.`;
  }
  if (events.length === 2) {
    const e = events[1];
    return `Weiterer Schauer gegen ${hhmm(e.start)}, ${WORD[e.peakCategory]}.`;
  }
  if (events.length === 1 && events[0].startsNow && !events[0].openEnded) {
    return "Danach trocken.";
  }
  return null;
}

function buildStatus(nowcast) {
  const { freshness, ageMin, ageUncertain, runTime, current, now } = nowcast;
  let status;
  if (freshness === "veryStale") {
    status = `Daten veraltet (${ageMin} Minuten), Vorhersage unsicher`;
  } else if (freshness === "stale") {
    status = `Daten ${ageMin} Minuten alt`;
  } else {
    const stamp = runTime ?? current?.validTime ?? now;
    status = `Stand ${hhmm(stamp)}`;
  }
  if (ageUncertain) status += " (geschätzt)";
  return status;
}

/**
 * @param {ReturnType<import('./nowcast.js').computeNowcast>} nowcast
 * @returns {{ headline: string, detail: string|null, status: string }}
 */
export function summarize(nowcast) {
  const status = buildStatus(nowcast);
  const { coverage, events, isolatedFrames, current, now } = nowcast;

  let headline;
  if (coverage === "none") {
    headline = "Keine Radardaten für diesen Ort.";
    return { headline, detail: null, status };
  }

  if (events.length === 0) {
    if (isolatedFrames.length > 0) {
      headline = `Weitgehend trocken, vereinzelt Tropfen möglich gegen ${hhmm(
        isolatedFrames[0].validTime
      )}.`;
    } else {
      headline = "Kein Regen in den nächsten 2 Stunden.";
    }
    return { headline, detail: null, status };
  }

  const e = events[0];

  if (e.startsNow) {
    const word = WORD[current.category];
    const rate = fmtRate(current.rateMmh);
    if (e.openEnded) {
      headline = `Es regnet gerade, ${word} (${rate} mm/h). Hält voraussichtlich die nächsten 2 Stunden an.`;
    } else {
      headline = `Es regnet gerade, ${word} (${rate} mm/h). Lässt voraussichtlich gegen ${hhmm(
        e.end
      )} nach.`;
    }
    return { headline, detail: buildDetail(nowcast), status };
  }

  // Kuenftiges Ereignis.
  if (e.uncertain) {
    headline = `Tendenz: ab etwa ${hhmm(e.start)} möglicherweise ${ADJ[e.peakCategory]} Regen.`;
    return { headline, detail: buildDetail(nowcast), status };
  }

  const adj = ADJ[e.peakCategory];
  const peak = fmtRate(e.peakMmh);
  const dur = durationPhrase(e);
  const n = minutesUntil(e.start, now);

  if (n < 3) {
    headline = `Gleich ${adj} Regen bis ${peak} mm/h, ${dur}.`;
  } else if (n <= 30) {
    headline = `Trocken, in ${n} Minuten ${adj} Regen bis ${peak} mm/h, ${dur}.`;
  } else {
    headline = `Trocken bis etwa ${hhmm(e.start)}, dann ${adj} Regen bis ${peak} mm/h, ${dur}.`;
  }
  return { headline, detail: buildDetail(nowcast), status };
}
