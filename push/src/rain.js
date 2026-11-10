// Regenalarm: aus einem Nowcast entscheiden, ob ein Abo jetzt eine Nachricht
// bekommt, und den Text bauen. Rein, ohne Netz und ohne Speicher; dieselbe
// Nowcast-Logik wie in der App, damit Alarm und Anzeige nie widersprechen.

import { categoryLabel } from "../../src/text.js";

const MIN = 60_000;

/**
 * Erstes belastbares Regenereignis, das innerhalb von `windowMin` beginnt.
 * Ein laufender Regen zaehlt mit (Beginn liegt dann in der Vergangenheit).
 * `usable: false`, wenn die Daten keine Aussage tragen; dann bleibt alles, wie es ist.
 */
export function upcomingRain(nowcast, windowMin) {
  if (nowcast.coverage === "none" || nowcast.freshness === "veryStale") return { usable: false };
  const now = nowcast.now.getTime();
  // Ereignisse sind zeitlich sortiert: liegt das erste ausserhalb, tun es alle.
  const first = nowcast.events.find((e) => !e.uncertain) ?? null;
  const event = first && first.start.getTime() - now <= windowMin * MIN ? first : null;
  return { usable: true, event, raining: Boolean(nowcast.current?.isRain) };
}

/**
 * Zustandsautomat je Abo. Zustand: { phase: "dry" | "alerted", alertedAt: ms | null }.
 *
 * Hoechstens eine Nachricht pro Regenphase: nach dem Alarm bleibt das Abo
 * "alerted", bis es trocken ist und kein Regen mehr im Fenster liegt. Danach
 * darf erst nach `cooldownMin` wieder alarmiert werden, damit ein flackernder
 * Nowcast an der Schwelle keine Serie ausloest.
 *
 * @returns {{ state: object, notify: object|null }} notify ist das ausloesende Ereignis
 */
export function decide(nowcast, prev, { windowMin, cooldownMin }) {
  const state = prev ?? { phase: "dry", alertedAt: null };
  const r = upcomingRain(nowcast, windowMin);
  if (!r.usable) return { state, notify: null };

  const now = nowcast.now.getTime();
  if (r.event) {
    const cooled = state.alertedAt === null || now - state.alertedAt >= cooldownMin * MIN;
    if (state.phase !== "alerted" && cooled) {
      return { state: { phase: "alerted", alertedAt: now }, notify: r.event };
    }
    return { state, notify: null };
  }
  if (!r.raining && state.phase === "alerted") {
    return { state: { phase: "dry", alertedAt: state.alertedAt }, notify: null };
  }
  return { state, notify: null };
}

function timeFormat(timeZone) {
  const opts = { hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return new Intl.DateTimeFormat("de-DE", { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat("de-DE", { ...opts, timeZone: "Europe/Berlin" });
  }
}

/**
 * Text der Mitteilung. Uhrzeiten in der Zeitzone des Geraets: der Worker
 * selbst laeuft in UTC und wuerde sonst eine Stunde daneben liegen.
 */
export function rainMessage(event, now, { place, timeZone }) {
  // leicht -> leichter, maessig -> maessiger, stark -> starker, sehr stark -> sehr starker
  const adj = `${categoryLabel(event.peakCategory)}er`;
  const minutes = Math.round((event.start.getTime() - now.getTime()) / MIN);
  const title = minutes < 3 ? `Gleich ${adj} Regen` : `${adj[0].toUpperCase()}${adj.slice(1)} Regen in ${minutes} Minuten`;
  const duration = `${event.openEnded ? "mindestens" : "etwa"} ${event.durationMin} Minuten`;
  const body = `${place}: ab ${timeFormat(timeZone).format(event.start)}, ${duration}.`;
  return { title, body };
}
