/**
 * Practice is judged by run (ADR 8): what a session says about the runs in its logs, and which logs stay out of the trends.
 * A log that was never enabled, or whose runs are all under 10 s, proves no margin or rate, so it is listed but not drawn in
 * the Trends. Pure: the Session view, the printed report and the tests all use these.
 */
import { SHORT_RUN_SECONDS } from '../match/match.ts'
import { modeOf } from './mode.ts'
import type { Session } from './session.ts'
import type { MatchSummary } from './summary.ts'

export type LeftOutWhy = 'never enabled' | 'only short runs'

/** Why a log is left out of trends, or null when it stays in. A summary without runs (a hand-built one) stays in. */
export function leftOutWhy(m: Pick<MatchSummary, 'runs'>): LeftOutWhy | null {
  const runs = m.runs
  if (!runs) return null
  if (runs.count === 0) return 'never enabled'
  return runs.seconds.every((s) => s < SHORT_RUN_SECONDS) ? 'only short runs' : null
}

export interface RunsSummary { logs: number; runs: number; neverEnabled: number; onlyShort: number }

export function runsSummary(logs: readonly Pick<MatchSummary, 'runs'>[]): RunsSummary {
  const why = logs.map(leftOutWhy)
  return {
    logs: logs.length,
    runs: logs.reduce((n, m) => n + (m.runs?.count ?? 0), 0),
    neverEnabled: why.filter((w) => w === 'never enabled').length,
    onlyShort: why.filter((w) => w === 'only short runs').length,
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "12 logs, 31 runs; 4 never enabled or with only short runs". */
export function runsLine(s: RunsSummary): string {
  const none = s.neverEnabled + s.onlyShort
  return `${plural(s.logs, 'log')}, ${plural(s.runs, 'run')} in all${none ? `; ${none} never enabled or with only short runs (under ${SHORT_RUN_SECONDS} s)` : ''}.`
}

/** "12 logs left out of trends: 9 never enabled, 3 only short runs"; empty when none are. */
export function leftOutLine(s: RunsSummary): string {
  const out = s.neverEnabled + s.onlyShort
  if (out === 0) return ''
  const parts = [s.neverEnabled ? `${s.neverEnabled} never enabled` : '', s.onlyShort ? `${s.onlyShort} only short runs` : ''].filter(Boolean)
  return `${plural(out, 'log')} left out of trends: ${parts.join(', ')}`
}

/** What a trend row counts: "match" on an event, "log" on a practice day, so the two never share a line unlabelled. */
export type TrendUnit = 'match' | 'log'

/** The logs a session's trends draw, the ones left out (with why), and the unit the rows are named in. */
export function trendSet(session: Session): { logs: MatchSummary[]; leftOut: { log: MatchSummary; why: LeftOutWhy }[]; unit: TrendUnit } {
  if (modeOf(session) !== 'practice') return { logs: session.matches, leftOut: [], unit: 'match' }
  const leftOut = session.matches.flatMap((log) => { const why = leftOutWhy(log); return why ? [{ log, why }] : [] })
  return { logs: session.matches.filter((m) => !leftOutWhy(m)), leftOut, unit: 'log' }
}

/** "3 runs (12 s, 40 s, 6 s)" for the list of logs; "never enabled" for none. */
export function runsText(m: Pick<MatchSummary, 'runs'>): string {
  const runs = m.runs
  if (!runs) return ''
  if (runs.count === 0) return 'never enabled'
  const shown = runs.seconds.slice(0, 6).map((s) => `${Math.round(s)} s`).join(', ')
  return `${plural(runs.count, 'run')} (${shown}${runs.count > 6 ? ', …' : ''})`
}
