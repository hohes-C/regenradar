// Fixture-Builder fuer die reinen Logik-Tests. Baut aus einer Liste von
// Zentrumswerten (rohe Einheiten, 0,01 mm/5min) eine RadarSeries.
//
// Frame 0 liegt auf `now` und ist damit der `current`-Frame, Frame i liegt auf
// now + i*FRAME_MIN. Ein `null`-Eintrag erzeugt einen Frame ganz ohne Daten.

const MIN = 60_000;
export const BASE_NOW = new Date("2026-01-01T12:00:00Z");

/**
 * @param {(number|null)[]} centerValues rohe Einheiten pro Frame
 * @param {object} [options]
 * @param {Date}   [options.now=BASE_NOW]
 * @param {'center'|'zero'} [options.neighbors='center'] Nachbarwerte
 * @param {number} [options.runOffsetMin=0] runTime = now - offset
 * @param {boolean}[options.runTimeNull=false]
 * @param {[number,number][]} [options.holes=[]] Zellen, die in Datenframes null werden
 */
export function buildSeries(centerValues, options = {}) {
  const {
    now = BASE_NOW,
    neighbors = "center",
    runOffsetMin = 0,
    runTimeNull = false,
    holes = [],
  } = options;

  const frames = centerValues.map((val, i) => {
    const validTime = new Date(now.getTime() + i * 5 * MIN);
    let grid;
    if (val === null) {
      grid = Array.from({ length: 5 }, () => Array(5).fill(null));
    } else {
      grid = Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 5 }, (_, co) =>
          neighbors === "center" ? val : r === 2 && co === 2 ? val : 0
        )
      );
      for (const [r, co] of holes) grid[r][co] = null;
    }
    return { validTime, grid, isForecast: validTime.getTime() > now.getTime() };
  });

  const runTime = runTimeNull ? null : new Date(now.getTime() - runOffsetMin * MIN);
  return { fetchedAt: now, runTime, center: { row: 2, col: 2 }, frames };
}

/** now + min Minuten als Date. */
export function at(minFromNow, now = BASE_NOW) {
  return new Date(now.getTime() + minFromNow * MIN);
}
