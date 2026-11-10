// A robot that logs only its fuel gauge's battery name (the profile's battery.gaugeName), and the Session view's Batteries
// table. Synthetic logs and summaries; invented battery labels.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { batteryAt } from '../src/match/battery-id.ts'
import { describeLog } from '../src/hub/describe.ts'
import { summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import { batteryTable, batteryVerdict } from '../src/session/batteries.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const GAUGE = '/RealMetadata/BFG Name'
const base: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6], [30, 11]] },
]
const file = (extra: FixtureEntry[]) => ({ name: 'synthetic.wpilog', bytes: writeWpilog([...base, ...extra]) })
const analyse = (extra: FixtureEntry[]) => analyzeFiles([file(extra)], offseason2026).analyses[0]

describe('the battery named by its fuel gauge', () => {
  it('names the battery from the gauge when the tracker ID is not logged (metadata written before the match)', () => {
    const a = analyse([{ name: GAUGE, type: 'string', records: [[2, 'B07']] }])
    expect(batteryAt(a.match, a.match.matchStart!)).toEqual({ id: 'B07', from: 'gauge' })
    expect(fired(a.report)).not.toContain('battery/identity')
    expect(a.report.skipped.map((s) => s.rule)).not.toContain('battery/identity')
  })
  it('prefers the tracker ID when both are logged', () => {
    const a = analyse([
      { name: GAUGE, type: 'string', records: [[2, 'B07']] },
      { name: '/RealOutputs/Battery/Id', type: 'string', records: [[10, 'B12']] },
      { name: '/RealOutputs/Battery/IdSource', type: 'string', records: [[10, 'gauge']] },
    ])
    expect(batteryAt(a.match, a.match.matchStart!)).toEqual({ id: 'B12', from: 'tracker' })
  })
  it('fires battery/identity when the gauge name is logged blank (the gauge was not answering)', () => {
    const a = analyse([{ name: GAUGE, type: 'string', records: [[2, '']] }])
    expect(batteryAt(a.match, a.match.matchStart!)).toBeNull()
    expect(fired(a.report)).toContain('battery/identity')
  })
  it('leaves battery/identity not checked when neither key is logged', () => {
    expect(analyse([]).report.skipped.map((s) => s.rule)).toContain('battery/identity')
  })
  it('gives the Library and the session summary the gauge name', () => {
    // The Library picks the robot by the log's own code name, so the log carries it.
    const f = file([
      { name: GAUGE, type: 'string', records: [[2, 'B07']] },
      { name: '/RealMetadata/Codebase', type: 'string', records: [[2, '2026 Offseason']] },
      { name: '/RealMetadata/GitBranch', type: 'string', records: [[2, 'main']] },
    ])
    expect(describeLog(f.name, f.bytes).batteryId).toBe('B07')
    expect(summarizeLog(f, offseason2026)!.batteryId).toBe('B07')
  })
})

const summary = (fileName: string, matchLabel: string, below: number | null, extra: Partial<MatchSummary> = {}, partly = false): MatchSummary =>
  ({ fileName, matchLabel, matchType: 2, onField: true, batteryId: null, metrics: below === null ? {} : { belowHealthyVolts: below, belowHealthyAh: 6.25, pastHealthyCurve: partly }, ...extra }) as unknown as MatchSummary

describe('the Batteries table', () => {
  const matches = [
    summary('a', 'Qualification 3', 0.21, { batteryId: 'B1' }),
    summary('b', 'Qualification 9', 1.36, { batteryId: 'B2' }, true),
    summary('c', 'Qualification 14', 0.47),
    summary('d', 'Qualification 20', 1.62, { batteryId: 'B2' }),
    summary('e', 'Qualification 25', null, { batteryId: 'B3' }),
  ]
  const table = batteryTable(matches, { c: 'B1' })

  it('puts the battery furthest below a healthy one first, and one with nothing measured last', () => {
    expect(table.rows.map((r) => r.battery)).toEqual(['B2', 'B1', 'B3'])
    expect(table.rows[0].worst?.label).toBe('Q20')
    expect(table.rows[0].matches.map((m) => [m.label, m.volts, m.past, m.partly])).toEqual([['Q9', 1.36, false, true], ['Q20', 1.62, true, false]])
  })
  it('takes a typed label where none was logged, and counts the matches with no name', () => {
    expect(table.rows[1].matches.map((m) => m.label)).toEqual(['Q3', 'Q14'])
    expect(batteryTable(matches).unnamed).toBe(1)
  })
  it('says a battery past the line needs a capacity test, and one within it is within it', () => {
    expect(batteryVerdict(table.rows[0], table.line)).toBe('More than 1.5 V below a healthy battery in 1 of 2 matches: capacity-test it before it plays again.')
    expect(batteryVerdict(table.rows[1], table.line)).toBe('Within 1.5 V of a healthy battery in all 2 matches.')
    const partly = batteryTable([summary('f', 'Qualification 30', 0.75, { batteryId: 'B4' }, true)]).rows[0]
    expect(batteryVerdict(partly, 1.5)).toBe('Within 1.5 V of a healthy battery in its 1 match, compared only up to 6.25 Ah.')
    expect(batteryVerdict(table.rows[2], table.line)).toMatch(/^Not measured/)
  })
})
