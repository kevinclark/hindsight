// A practice session shows its runs and leaves never-enabled logs and logs of only short runs out of the trends;
// trend rows name their unit. Invented summaries.
import { describe, expect, it } from 'vitest'
import { groupSessions } from '../src/session/session.ts'
import { leftOutLine, leftOutWhy, runsLine, runsSummary, runsText, trendSet } from '../src/session/runs.ts'
import { withModeChoice } from '../src/session/mode.ts'
import { trendRows } from '../src/session/trends.ts'
import { trendsModel } from '../src/report/session-model.ts'
import type { MatchSummary } from '../src/session/summary.ts'

const METRICS = { minVolts: 8, secondsUnder7: 0, chargeAh: 1, resistanceMilliohms: null, followerSecondsOff: null, brownoutVolts: 6, loopOverrunPct: 5, visionOutlierPct: null }
const log = (fileName: string, playedAt: number, seconds: number[], over: Partial<MatchSummary> = {}) => ({
  fileName, playedAt, onField: false, event: '', matchLabel: '', matchType: 0, rules: {}, metrics: METRICS,
  runs: { count: seconds.length, seconds, droppedShort: 0 }, ...over,
} as unknown as MatchSummary)
const day = Date.UTC(2025, 6, 12, 18)
const logs = [
  log('long', day, [120, 30]), log('never', day + 60e3, []), log('short', day + 120e3, [4, 7]), log('mixed', day + 180e3, [4, 50]),
  log('never2', day + 240e3, []),
]

describe('which logs stay out of trends', () => {
  it('never enabled, and only runs under 10 s; a run of exactly 10 s counts', () => {
    expect(logs.map((m) => leftOutWhy(m))).toEqual([null, 'never enabled', 'only short runs', null, 'never enabled'])
    expect(leftOutWhy(log('ten', day, [10]))).toBeNull()
    expect(leftOutWhy({} as MatchSummary)).toBeNull()
  })
  it('the session line and the count line say it in words', () => {
    const s = runsSummary(logs)
    expect(s).toEqual({ logs: 5, runs: 6, neverEnabled: 2, onlyShort: 1 })
    expect(runsLine(s)).toBe('5 logs, 6 runs in all; 3 never enabled or with only short runs (under 10 s).')
    expect(leftOutLine(s)).toBe('3 logs left out of trends: 2 never enabled, 1 only short runs')
    expect(leftOutLine(runsSummary([logs[0]]))).toBe('')
    expect(leftOutLine(runsSummary([logs[1]]))).toBe('1 log left out of trends: 1 never enabled')
  })
  it('each log lists its runs', () => {
    expect(runsText(logs[0])).toBe('2 runs (120 s, 30 s)')
    expect(runsText(logs[1])).toBe('never enabled')
    expect(runsText(log('many', day, Array.from({ length: 9 }, (_, i) => i + 1)))).toBe('9 runs (1 s, 2 s, 3 s, 4 s, 5 s, 6 s, …)')
  })
})

describe('trends by unit', () => {
  const [practice] = groupSessions(logs)
  it('a practice day draws the logs that were run, per log', () => {
    const set = trendSet(practice)
    expect(set.unit).toBe('log')
    expect(set.logs.map((m) => m.fileName)).toEqual(['long', 'mixed'])
    expect(set.leftOut.map((x) => [x.log.fileName, x.why])).toEqual([['never', 'never enabled'], ['short', 'only short runs'], ['never2', 'never enabled']])
    expect(trendRows(set.logs, set.unit).find((r) => r.metric.key === 'minVolts')!.verdict).toBe('Under 7 V in 0 of 2 logs')
    expect(trendsModel(set.logs, {}, 100, 16, 3, set.unit).unit).toBe('log')
  })
  it('an event keeps every match and says match', () => {
    const matches = [log('q1', day, [150], { onField: true, event: 'TEST', matchType: 2 }), log('q2', day + 600e3, [150], { onField: true, event: 'TEST', matchType: 2 })]
    const [event] = groupSessions(matches)
    expect(trendSet(event)).toMatchObject({ unit: 'match', leftOut: [] })
    expect(trendRows(trendSet(event).logs, 'match').find((r) => r.metric.key === 'minVolts')!.verdict).toBe('Under 7 V in 0 of 2 matches')
  })
  it('an event set to practice by hand counts per log; a practice day set to event leaves nothing to draw per log', () => {
    const matches = [log('q1', day, [150], { onField: true, event: 'TEST', matchType: 2 }), log('pit', day + 600e3, [])]
    const id = groupSessions(matches)[0].id
    const [asPractice] = groupSessions(matches, {}, withModeChoice({}, id, 'practice'))
    expect(trendSet(asPractice)).toMatchObject({ unit: 'log' })
    expect(trendSet(asPractice).logs.map((m) => m.fileName)).toEqual(['q1'])
  })
})
