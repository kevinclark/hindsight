/**
 * Which Foresight checks have earned red. Every check starts amber; one turns red only after the backtest
 * (scripts/foresight-backtest.ts) found zero false reds on the field logs available, on the stretch where the robot sat
 * disabled with the field attached. The verdict screen says how many logs each red was proven on.
 *
 * Edit this table only from a backtest run, and record the run in docs/measurements.md ("Foresight backtest").
 * The proof covers a robot sitting disabled before any enable; after a drive, rest voltage stays amber (engine.ts).
 * Not here: alerts/passthrough (one false red: another team's always-on "limelight name is invalid" alert),
 * the battery tracker checks and commit-matches (no log to judge them on yet), gyro-still-drift (context, no line).
 */
export interface Proof {
  /** Match logs the check could run on (it read its signals there). */
  logs: number
  /** Of those, how many it fired on (each judged a real problem). Zero: nothing yet shows it fires when it should. */
  fires: number
  /** Where those logs came from, in a few words. */
  base: string
  /** When the backtest ran (YYYY-MM-DD). */
  date: string
}

const OURS = 'CalGames 2026'
const RUN = '2026-10-19'

export const PROVEN: Record<string, Proof> = {
  // Fired once (Q21, 12.45 V before auto, a real low battery).
  'power/rest-voltage': { logs: 9, fires: 1, base: `${OURS} + 6 logs of 5 other teams, 2024–26`, date: RUN },
  // Fired twice (P0 and team 2151's ILCH Q19), both really running uncommitted code.
  'build/dirty': { logs: 6, fires: 2, base: `${OURS} + 3 other teams' AdvantageKit logs`, date: RUN },
  // Never fired; only our robot's own signals.
  'can/device-dropout': { logs: 3, fires: 0, base: OURS, date: RUN },
  'foresight/controllers': { logs: 3, fires: 0, base: OURS, date: RUN },
  'foresight/zero-sanity': { logs: 3, fires: 0, base: OURS, date: RUN },
  'vision/stale': { logs: 3, fires: 0, base: OURS, date: RUN },
  'vision/time-sync': { logs: 8, fires: 0, base: `${OURS} + 5 logs of 4 other teams with robot alerts`, date: RUN },
}
