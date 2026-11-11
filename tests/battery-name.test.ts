// A robot that logs only its fuel gauge's battery name (the profile's battery.gaugeName), and the Session view's Batteries
// table. Synthetic logs and summaries; invented battery labels.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { batteryAt } from '../src/match/battery-id.ts'
import { describeLog } from '../src/hub/describe.ts'
import { joinPieces, summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import { batteryTable, batteryVerdict } from '../src/session/batteries.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { LOGS, fired, haveLogs, readInput } from './helpers/load.ts'

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
  it('takes the gauge name when the tracker ID is logged blank, and the rule agrees', () => {
    const a = analyse([
      { name: GAUGE, type: 'string', records: [[2, 'B07']] },
      { name: '/RealOutputs/Battery/Id', type: 'string', records: [[10, '']] },
      { name: '/RealOutputs/Battery/IdSource', type: 'string', records: [[10, 'none']] },
    ])
    expect(batteryAt(a.match, a.match.matchStart!)).toEqual({ id: 'B07', from: 'gauge' })
    expect(fired(a.report)).not.toContain('battery/identity')
  })
  it('still fires on a tracker ID typed in at the dashboard, gauge name or not', () => {
    const a = analyse([
      { name: GAUGE, type: 'string', records: [[2, 'B07']] },
      { name: '/RealOutputs/Battery/Id', type: 'string', records: [[10, 'B12']] },
      { name: '/RealOutputs/Battery/IdSource', type: 'string', records: [[10, 'dashboard']] },
    ])
    expect(fired(a.report)).toContain('battery/identity')
  })
  it('reads no battery from a name logged only after the match started, or one of spaces', () => {
    const late = analyse([{ name: GAUGE, type: 'string', records: [[25, 'B07']] }])
    expect(batteryAt(late.match, late.match.matchStart!)).toBeNull()
    const spaces = analyse([{ name: GAUGE, type: 'string', records: [[2, '   ']] }])
    expect(batteryAt(spaces.match, spaces.match.matchStart!)).toBeNull()
    expect(fired(spaces.report)).toContain('battery/identity')
  })
  it('says to plug the gauge in, not to type a label, when the gauge name is blank', () => {
    const f = analyse([{ name: GAUGE, type: 'string', records: [[2, '']] }]).report.findings.find((x) => x.rule === 'battery/identity')!
    expect(f.nextStep).toMatch(/^Plug the battery's fuel gauge into the robot/)
    expect(f.causes.filter((c) => c.ruledOut).map((c) => c.id).sort()).toEqual(['code', 'no-label'])
  })
  it('does not judge a log the robot never enabled', () => {
    const never = analyzeFiles([{ name: 'never.wpilog', bytes: writeWpilog([
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6], [30, 12.5]] },
      { name: GAUGE, type: 'string', records: [[2, '']] },
    ]) }], offseason2026).analyses[0].report
    expect(fired(never)).not.toContain('battery/identity')
    expect(never.skipped.map((x) => x.rule)).toContain('battery/identity')
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
    summary('a', 'Qualification 3', 0.18, { batteryId: 'B1' }),
    summary('b', 'Qualification 9', 1.41, { batteryId: 'B2' }, true),
    summary('c', 'Qualification 14', 0.52),
    summary('d', 'Qualification 20', 1.62, { batteryId: 'B2' }),
    summary('e', 'Qualification 25', null, { batteryId: 'B3' }),
  ]
  const table = batteryTable(matches, { c: 'B1' })

  it('puts the battery furthest below a healthy one first, and one with nothing measured last', () => {
    expect(table.rows.map((r) => r.battery)).toEqual(['B2', 'B1', 'B3'])
    expect(table.rows[0].worst?.label).toBe('Q20')
    expect(table.rows[0].matches.map((m) => [m.label, m.volts, m.past, m.partly])).toEqual([['Q9', 1.41, false, true], ['Q20', 1.62, true, false]])
  })
  it('takes a typed label where none was logged, and counts the matches with no name', () => {
    expect(table.rows[1].matches.map((m) => m.label)).toEqual(['Q3', 'Q14'])
    expect(batteryTable(matches).unnamed).toBe(1)
  })
  it('says a battery past the line needs a capacity test, and one within it is within it', () => {
    expect(batteryVerdict(table.rows[0], table.line)).toBe('More than 1.5 V below a healthy battery in 1 of 2 matches: capacity-test it before it plays again.')
    expect(batteryVerdict(table.rows[1], table.line)).toBe('Within 1.5 V of a healthy battery in both matches.')
  })
  it('gives no "within" verdict for a match that drew past the healthy curve: it says how far below it was there', () => {
    const one = batteryTable([summary('f', 'Qualification 30', 1.41, { batteryId: 'B4' }, true)]).rows[0]
    expect(batteryVerdict(one, 1.5)).toBe('Not judged past 6.25 Ah in its 1 match (it drew more): up to 1.41 V below a healthy battery there.')
    const mixed = batteryTable([summary('f', 'Qualification 30', 0.9, { batteryId: 'B4' }, true), summary('g', 'Qualification 34', 0.2, { batteryId: 'B4' })]).rows[0]
    expect(batteryVerdict(mixed, 1.5)).toBe('Not judged past 6.25 Ah in 1 match (it drew more): up to 0.90 V below a healthy battery there; within 1.5 V in the other 1 match.')
  })
  it('judges the line on the unrounded number, as the rule does', () => {
    expect(batteryTable([summary('h', 'Qualification 40', 1.503, { batteryId: 'B5' })]).rows[0].pastCount).toBe(1)
  })
  it('tells a summary saved before the number was kept from a log that cannot be compared', () => {
    expect(batteryVerdict(table.rows[2], table.line)).toMatch(/^Not compared yet: read these logs again/)
    const none = batteryTable([summary('i', 'Qualification 41', null, { batteryId: 'B6', metrics: { belowHealthyVolts: null, belowHealthyAh: null, pastHealthyCurve: false } } as never)]).rows[0]
    expect(batteryVerdict(none, 1.5)).toMatch(/^Not measured: these logs have too little/)
  })
  it('marks a match joined from restart pieces as compared only in part (each piece counts charge from its own start)', () => {
    const piece = (n: number) => ({ ...summary(`p${n}`, 'Qualification 50', 0.3, { batteryId: 'B7' }), rules: {}, fileSize: 1, timing: { parseMs: 0, rulesMs: 0 }, problems: [], robot: { present: 1, total: 1 }, logging: [] } as unknown as MatchSummary)
    const joined = joinPieces([piece(1), piece(2)])
    expect(joined.metrics).toMatchObject({ belowHealthyVolts: 0.3, pastHealthyCurve: true })
  })
})

describe.skipIf(!haveLogs)('the summary\'s number on a real log', () => {
  it('equals power/battery-collapse\'s own measured value', () => {
    const input = readInput(LOGS.c)
    const finding = analyzeFiles([input]).analyses[0].report.findings.find((f) => f.rule === 'power/battery-collapse')!
    expect(summarizeLog(input)!.metrics.belowHealthyVolts).toBeCloseTo(finding.measured![0].value, 2)
  })
})
