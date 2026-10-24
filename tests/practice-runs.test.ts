// Practice is judged by run (ADR 8): runs are found, off the field every run is judged, a performance finding in a run
// under 10 s is dropped and counted, and the rules say which they are. Made-up logs only.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { RUN_JOIN_SECONDS, SHORT_RUN_SECONDS, runsOf, runAt, matchWhen } from '../src/match/match.ts'
import { FORESIGHT_RULES, RULES } from '../src/rules/index.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { summarizeMatch } from '../src/session/summary.ts'
import { describeLog } from '../src/hub/describe.ts'
import { usableReading } from '../src/hub/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const analyse = (entries: FixtureEntry[]) => analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0]

/** Enabled from each [start, end] pair, disabled in between; the FMS attached when `fms`. */
const enabledAt = (runs: [number, number][], fms = false): FixtureEntry[] => [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], ...runs.flatMap(([a, b]) => [[a, true], [b, false]] as [number, boolean][])] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
  { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, fms]] },
  { name: '/DriverStation/DSAttached', type: 'boolean', records: [[0, true]] },
  { name: '/SystemStats/BrownoutVoltage', type: 'double', records: [[0, 6]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [500, 12.4]] },
]

describe('what a run is', () => {
  const iv = (start: number, end: number) => ({ start, end })
  it('stretches closer than the join gap are one run; the gap itself is not shorter than the gap', () => {
    expect(RUN_JOIN_SECONDS).toBe(3)
    expect(runsOf([iv(10, 20), iv(22.9, 30)], [])).toEqual([{ start: 10, end: 30, auto: false }])
    expect(runsOf([iv(10, 20), iv(23, 30)], [])).toEqual([{ start: 10, end: 20, auto: false }, { start: 23, end: 30, auto: false }])
  })
  it('auto is whether the run began in autonomous', () => {
    expect(runsOf([iv(10, 20), iv(100, 110)], [iv(10, 20)]).map((r) => r.auto)).toEqual([true, false])
  })
  it('a log never enabled has no runs', () => {
    expect(analyse(enabledAt([])).match.runs).toEqual([])
  })
})

describe('off the field the window is every run', () => {
  const log = () => analyse(enabledAt([[10, 40], [100, 104], [200, 260]]))
  it('runs, first enable to the end of the last, and times say which run', () => {
    const { match } = log()
    expect(match.runs).toEqual([{ start: 10, end: 40, auto: false }, { start: 100, end: 104, auto: false }, { start: 200, end: 260, auto: false }])
    expect([match.matchStart, match.matchEnd]).toEqual([10, 260])
    expect(matchWhen(match, 215)).toBe('0:15 into run 3 of 3 (teleop; robot time 215.0 s)')
    expect(matchWhen(match, 150)).toBe('between run 2 and run 3 of 3 (robot time 150.0 s)')
    expect(matchWhen(match, 5)).toBe('before the first run (robot time 5.0 s)')
    expect(matchWhen(match, 300)).toBe('after the last run (robot time 300.0 s)')
    expect(runAt(match, 150)).toMatchObject({ n: 2, of: 3, inside: false })
  })
  it('a log with one run reads as before: "into the match"', () => {
    const { match } = analyse(enabledAt([[10, 60]]))
    expect(matchWhen(match, 20)).toBe('0:10 into the match (teleop; robot time 20.0 s)')
  })
  it('a comms loss in a later run is found (it was past the first run plus a game length) and says which run', () => {
    const f = analyse([
      ...enabledAt([[10, 40], [1000, 1060]]),
      { name: '/SystemStats/CommsDisableCount', type: 'int64', records: [[0, 0], [1030, 1]] },
    ]).report.findings.find((x) => x.rule === 'comms/loss')
    expect(f?.run).toBe(2)
    expect(f?.title).toMatch(/at 0:30 into run 2 of 2/)
  })
  it('the Driver Station closing between runs is not a comms loss; closing during one is', () => {
    const entries = (detachAt: number): FixtureEntry[] => [
      ...enabledAt([[10, 40], [200, 260]]).filter((e) => e.name !== '/DriverStation/DSAttached'),
      { name: '/DriverStation/DSAttached', type: 'boolean', records: [[0, true], [detachAt, false], [detachAt + 5, true]] },
      { name: '/SystemStats/CommsDisableCount', type: 'int64', records: [[0, 0]] },
    ]
    const lost = (at: number) => analyse(entries(at)).report.findings.some((x) => x.rule === 'comms/loss')
    expect(lost(100)).toBe(false)
    expect(lost(220)).toBe(true)
  })
  it('on the field the FMS match is one run and nothing about the window changes', () => {
    const { match } = analyse(enabledAt([[10, 25], [28, 163], [900, 940]], true))
    expect(match.fms).toBe(true)
    expect([match.matchStart, match.matchEnd]).toEqual([10, 163])
    expect(match.runs).toEqual([{ start: 10, end: 163, auto: false }, { start: 900, end: 940, auto: false }])
    expect(matchWhen(match, 50)).toBe('0:40 into the match (teleop; robot time 50.0 s)')
  })
})

describe('a run under 10 s is checked for faults only', () => {
  // A 6.5 V sag (power/margin, performance) and a comms loss (comms/loss, fault), each once in a 5 s run and once in a long one.
  const sag = (at: number): FixtureEntry => ({ name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [at, 6.5], [at + 0.5, 12.4]] })
  const loss = (...at: number[]): FixtureEntry => ({ name: '/SystemStats/CommsDisableCount', type: 'int64', records: [[0, 0], ...at.map((t, i) => [t, i + 1] as [number, number])] })
  const base = enabledAt([[10, 15], [100, 160]]).filter((e) => e.name !== '/SystemStats/BatteryVoltage')
  it('drops the performance finding in the short run, counts it, and keeps the same finding in a long run', () => {
    expect(SHORT_RUN_SECONDS).toBe(10)
    const short = analyse([...base, sag(12)])
    expect(short.report.findings.some((f) => f.rule === 'power/margin')).toBe(false)
    expect(short.report.droppedInShortRuns).toEqual(['power/margin'])
    const long = analyse([...base, sag(120)])
    expect(long.report.findings.find((f) => f.rule === 'power/margin')?.run).toBe(2)
    expect(long.report.droppedInShortRuns).toBeUndefined()
  })
  it('keeps a fault in the short run', () => {
    const a = analyse([...base, loss(12)])
    expect(a.report.findings.find((f) => f.rule === 'comms/loss')?.run).toBe(1)
    expect(a.report.droppedInShortRuns).toBeUndefined()
  })
  it('the summary carries the runs and the count', () => {
    const a = analyse([...base, sag(12)])
    const s = summarizeMatch(a.match, a.report, 1)
    expect(s.runs).toEqual({ count: 2, seconds: [5, 60], droppedShort: 1 })
  })
  it('never drops on the field, where the match is the run', () => {
    const a = analyse([...enabledAt([[10, 25], [28, 163]], true).filter((e) => e.name !== '/SystemStats/BatteryVoltage'), sag(12)])
    expect(a.report.findings.some((f) => f.rule === 'power/margin')).toBe(true)
    expect(a.report.droppedInShortRuns).toBeUndefined()
  })
})

describe('every rule says what it judges', () => {
  const all = [...new Map([...RULES, ...FORESIGHT_RULES].map((r) => [r.id, r])).values()]
  it('all 44 rules choose, 20 faults and 24 performance', () => {
    expect(all.length).toBe(44)
    expect(all.every((r) => r.judges === 'fault' || r.judges === 'performance')).toBe(true)
    expect(all.filter((r) => r.judges === 'fault').length).toBe(20)
  })
  it('the faults are the ones where something broke, disconnected, restarted or was disabled', () => {
    expect(all.filter((r) => r.judges === 'fault').map((r) => r.id).sort()).toEqual([
      'alerts/passthrough', 'auto/early-disable', 'can/bus-dropout', 'can/device-dropout', 'can/device-rebooted', 'can/input-disconnected',
      'can/usb-dropout', 'comms/ds-log-truncated', 'comms/emergency-stop', 'comms/loss', 'foresight/controllers', 'foresight/log-usb-stick',
      'foresight/sticky-faults', 'foresight/values-updating', 'loop/restart-mid-match', 'mech/stuck-state', 'mech/zero-not-completed',
      'power/brownout', 'power/pd-not-reporting', 'vision/stale',
    ])
  })
})

describe('the describer keeps the runs', () => {
  it('a reading has the count and each length, and a malformed one is dropped', () => {
    const meta = describeLog('t.wpilog', writeWpilog(enabledAt([[10, 40], [100, 104]])))
    expect(meta.runs).toEqual({ count: 2, seconds: [30, 4] })
    expect(usableReading({ runs: { count: 2, seconds: [30, 4] } })).toEqual({ runs: { count: 2, seconds: [30, 4] } })
    expect(usableReading({ runs: { count: 3, seconds: [30, 4] } })).toEqual({})
    expect(usableReading({ runs: { count: 1, seconds: ['x'] } })).toEqual({})
  })
})
