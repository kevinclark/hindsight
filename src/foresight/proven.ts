/**
 * Which Foresight checks have earned red. Every check starts amber. One turns red only when the backtest
 * (scripts/foresight-backtest.ts) found zero false reds on the field logs available, on the stretch where the robot sat
 * disabled with the field attached, AND it has fired for real on at least one of 8033's own logs (Kevin, 2026-10-19:
 * a check that has never caught a real fault on our robot stays amber, however many clean logs it passed).
 * The verdict screen says how many logs each check was proven on.
 *
 * Edit this table only from a backtest run, and record the run in docs/measurements.md ("Foresight backtest").
 * The proof covers a robot sitting disabled before any enable; after a drive, rest voltage stays amber (engine.ts).
 * Not here: foresight/camera-sees-tag (a step for a person, grey, never a verdict),
 * alerts/passthrough (one false red: another team's always-on "limelight name is invalid" alert),
 * the battery tracker checks and commit-matches (no log to judge them on yet), gyro-still-drift (context, no line).
 */
export interface Proof {
  /** Match logs the check could run on (it read its signals there). */
  logs: number
  /** Of those, how many it fired on (each judged a real problem). Zero: nothing yet shows it fires when it should. */
  fires: number
  /** Of those real fires, how many were on 8033's own logs. Red needs at least one. */
  ourFires: number
  /** Where those logs came from, in a few words. */
  base: string
  /** When the backtest ran (YYYY-MM-DD). */
  date: string
}

const OURS = 'CalGames 2026'
const RUN = '2026-10-19'

export const PROVEN: Record<string, Proof> = {
  // Fired once (Q21, 12.45 V before auto, a real low battery).
  'power/rest-voltage': { logs: 9, fires: 1, ourFires: 1, base: `${OURS} + 6 logs of 5 other teams, 2024–26`, date: RUN },
  // Fired twice (P0 and team 2151's ILCH Q19), both really running uncommitted code; P0 is ours.
  'build/dirty': { logs: 6, fires: 2, ourFires: 1, base: `${OURS} + 3 other teams' AdvantageKit logs`, date: RUN },
  // No false reds, but never fired on our logs, so amber until one does (then set ourFires from that run).
  'can/device-dropout': { logs: 3, fires: 0, ourFires: 0, base: OURS, date: RUN },
  'foresight/controllers': { logs: 3, fires: 0, ourFires: 0, base: OURS, date: RUN },
  'foresight/zero-sanity': { logs: 3, fires: 0, ourFires: 0, base: OURS, date: RUN },
  'vision/stale': { logs: 3, fires: 0, ourFires: 0, base: OURS, date: RUN },
  'vision/time-sync': { logs: 8, fires: 0, ourFires: 0, base: `${OURS} + 5 logs of 4 other teams with robot alerts`, date: RUN },
  // Added with the checks themselves (backtest of 2026-10-19 evening): no false reds, never fired, so amber.
  'foresight/motor-temperature': { logs: 5, fires: 0, ourFires: 0, base: `${OURS} + 2 logs of team 340`, date: RUN },
  'foresight/values-updating': { logs: 3, fires: 0, ourFires: 0, base: OURS, date: RUN },
}

/** Red needs a clean backtest and at least one real fire on our own logs. */
export function earnsRed(p: Proof | undefined): boolean {
  return !!p && p.ourFires > 0
}
