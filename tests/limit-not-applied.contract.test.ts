// Contract tests for power/limit-not-applied: each test proves the obligations its name starts with, in
// docs/contracts/limit-not-applied.md. Made-up robot, made-up logs: one motor group, "Roller", of two motors.
// The rule runs alone through the runner (runRules), so what is checked is what a student sees: the finding, or the
// "not checked" line.
import { expect, test } from 'vitest'
import limitNotApplied from '../src/rules/power/limit-not-applied.ts'
import { motorGroup, runRules } from '../src/rules/run.ts'
import { MatchView } from '../src/rules/view.ts'
import * as SOURCES from '../src/rules/sources.ts'
import { buildMatch } from '../src/match/match.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { CurrentLimits, Motor, RobotProfile } from '../src/profiles/types.ts'
import type { LimitLines } from '../src/code/limit-lines.ts'
import type { Finding } from '../src/rules/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const PIN = 'abc1234'
const motor = (side: 'Left' | 'Right', keys = { connected: true }): Motor => ({
  name: `Roller ${side.toLowerCase()}`,
  supplyCurrent: `/Roller/${side}/SupplyCurrentAmps`,
  statorCurrent: `/Roller/${side}/StatorCurrentAmps`,
  ...(keys.connected ? { connected: `/Roller/${side}/Connected` } : {}),
})
const LIMITS: CurrentLimits = { supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'RollerIO.java:12-15' }

/** A made-up robot (the AdvantageKit keys of a built-in profile) with one group, Roller, of two motors. */
function robot(limits: Partial<CurrentLimits> = {}, motors: Motor[] = [motor('Left'), motor('Right')]): RobotProfile {
  return {
    ...offseason2026, name: 'Test robot', codebase: 'TestBot',
    code: { repo: 'example/test-robot', branch: 'main', sha: PIN },
    motorGroups: [{ name: 'Roller', motors, limits: { ...LIMITS, ...limits } }],
    otherDevices: [], canBuses: undefined, stateMachine: undefined,
  }
}

type Trace = [number, number | boolean][]
interface Log {
  /** Times the robot was enabled, [from, to] (default 10 to 110 s). */
  enabled?: [number, number][]
  /** The commit the log ran (default: the profile's). '' logs none. */
  ran?: string
  /** Records per key, e.g. { '/Roller/Left/SupplyCurrentAmps': [[0, 0], [20, 90], [21, 0]] }. */
  keys?: Record<string, Trace>
}
const L = { supply: '/Roller/Left/SupplyCurrentAmps', stator: '/Roller/Left/StatorCurrentAmps', connected: '/Roller/Left/Connected' }
const R = { supply: '/Roller/Right/SupplyCurrentAmps', stator: '/Roller/Right/StatorCurrentAmps', connected: '/Roller/Right/Connected' }
/** Every current at 5 A unless the log says otherwise. */
const QUIET: Record<string, Trace> = { [L.supply]: [[0, 5]], [L.stator]: [[0, 5]], [R.supply]: [[0, 5]], [R.stator]: [[0, 5]] }

function entries({ enabled = [[10, 110]], ran = PIN, keys = {} }: Log): FixtureEntry[] {
  const all = { ...QUIET, ...keys }
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], ...enabled.flatMap(([a, b]) => [[a, true], [b, false]] as Trace)] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [120, 12.4]] },
    ...(ran ? [{ name: '/RealMetadata/GitSHA', type: 'string', records: [[0, ran]] } as FixtureEntry] : []),
    ...Object.entries(all).filter(([, r]) => r.length).map(([name, records]) => ({
      name, type: name.endsWith('Connected') ? 'boolean' : 'double', records,
    }) as FixtureEntry),
  ]
}

const matchOf = (log: Log, profile = robot()) => buildMatch('t.wpilog', openWpilog(writeWpilog(entries(log))), profile)

/** Run the rule alone on that log: its findings and its "not checked" line. */
function run(log: Log = {}, profile = robot(), limitLines?: LimitLines) {
  const match = matchOf(log, profile)
  if (limitLines) match.limitLines = new Map([['Roller', limitLines]])
  const report = runRules(match, [limitNotApplied])
  expect(report.crashed).toEqual([])
  return { findings: report.findings.filter((f) => f.rule === limitNotApplied.id), skipped: report.skipped.find((s) => s.rule === limitNotApplied.id)?.reason }
}
const only = (log: Log = {}, profile = robot(), limitLines?: LimitLines): Finding => {
  const { findings } = run(log, profile, limitLines)
  expect(findings).toHaveLength(1)
  return findings[0]
}
/** The left motor's supply current at `amps` from `from` to `to` s, 5 A otherwise. Two records over the line (LN-04), the second halfway. */
const leftSupply = (amps: number, from = 20, to = 21): Log => ({ keys: { [L.supply]: [[0, 5], [from, amps], [(from + to) / 2, amps], [to, 5]] } })

test('[LN-01] the rule\'s id, title, severity, kind and cause ids are the ones already live', () => {
  const { id, title, severity, judges, who, forEach, causes } = limitNotApplied
  expect({ id, title, severity, judges, who, forEach }).toEqual({
    id: 'power/limit-not-applied', title: 'Current limit not holding', severity: 'error', judges: 'fault', who: ['software'], forEach: 'motorGroup',
  })
  expect(causes.map((c) => c.id)).toEqual(['limit-off', 'not-saved', 'default-limit', 'wrong-value'])
  expect(only(leftSupply(90)).key).toBe('power/limit-not-applied · Roller supply')
})

test('[LN-02] a group with no supply and no stator limit is not checked, and says where its limits would be', () => {
  const { findings, skipped } = run(leftSupply(90), robot({ supplyA: undefined, statorA: undefined }))
  expect(findings).toEqual([])
  expect(skipped).toBe('Roller: the robot profile has no current limits for Roller (RollerIO.java:12-15)')
})

test('[LN-03] each kind with a limit is checked on its own; a kind with no limit is not checked and not reported', () => {
  const both = run({ keys: { [L.supply]: [[0, 5], [20, 90], [20.5, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [30.5, 150], [31, 5]] } })
  expect(both.findings.map((f) => f.about).sort()).toEqual(['Roller stator', 'Roller supply'])
  expect(both.skipped).toBeUndefined()
  const supplyOnly = run({ keys: { [L.supply]: [[0, 5], [20, 90], [20.5, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [30.5, 150], [31, 5]] } }, robot({ statorA: undefined }))
  expect(supplyOnly.findings.map((f) => f.about)).toEqual(['Roller supply'])
  expect(supplyOnly.skipped).toBeUndefined()
  const statorOnly = run({ keys: { [L.supply]: [[0, 5], [20, 90], [20.5, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [30.5, 150], [31, 5]] } }, robot({ supplyA: undefined }))
  expect(statorOnly.findings.map((f) => f.about)).toEqual(['Roller stator'])
  // A kind with no limit isn't read at all: its currents missing from the log change nothing.
  const noStatorLogged = run({ keys: { [L.supply]: [[0, 5], [20, 90], [20.5, 90], [21, 5]], [L.stator]: [], [R.stator]: [] } }, robot({ statorA: undefined }))
  expect(noStatorLogged.findings.map((f) => f.about)).toEqual(['Roller supply'])
  expect(noStatorLogged.skipped).toBeUndefined()
})

test('[LN-04] it fires only above 120 % of the limit, not at it', () => {
  // 40 A limit: 120 % is exactly 48 A.
  expect(run(leftSupply(48)).findings).toEqual([])
  expect(only(leftSupply(48.01)).about).toBe('Roller supply')
  // 60 A stator limit: 72 A.
  expect(run({ keys: { [R.stator]: [[0, 5], [20, 72], [20.5, 72], [21, 5]] } }).findings).toEqual([])
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 72.01], [20.5, 72.01], [21, 5]] } }).about).toBe('Roller stator')
})

test('[LN-04] it fires only for a stretch longer than 0.2 s: exactly 0.2 s is the limiter catching up', () => {
  // 0.3 s to 0.5 s is exactly 0.2 s in floating point (10.3 s to 10.5 s is not).
  const early = (to: number): Log => ({ enabled: [[0.1, 110]], keys: { [L.supply]: [[0, 5], [0.3, 90], [0.4, 90], [to, 5]] } })
  expect(run(early(0.5)).findings).toEqual([])
  expect(only(early(0.500001)).time).toBeCloseTo(0.3, 6)
  expect(run(leftSupply(90, 20, 20.15)).findings).toEqual([])
  expect(only(leftSupply(90, 20, 20.25)).time).toBe(20)
})

test('[LN-04] a stretch counts only with at least 2 records over the line: one record held across a gap says nothing about how long', () => {
  // One record at 90 A, then the next record 0.3 s later: held 0.3 s, but only one record saw it.
  expect(run({ keys: { [L.supply]: [[0, 5], [20, 90], [20.3, 5]] } }).findings).toEqual([])
  // The same 0.3 s with a second record over the line: a finding.
  const two: Trace = [[0, 5], [20, 90], [20.15, 90], [20.3, 5]]
  expect(only({ keys: { [L.supply]: two } }).time).toBe(20)
  // At 4 Hz (records 0.25 s apart) the shortest stretch that counts is two records, 0.5 s.
  const at4Hz = (n: number): Trace => [[0, 5], ...Array.from({ length: n }, (_, i): [number, number] => [20 + i * 0.25, 90]), [20 + n * 0.25, 5]]
  expect(run({ keys: { [L.supply]: at4Hz(1) } }).findings).toEqual([])
  expect(only({ keys: { [L.supply]: at4Hz(2) } }).time).toBe(20)
})

test('[LN-04] one motor\'s single held record does not make it the worst motor, or add to the seconds over', () => {
  const finding = only({ keys: {
    // Left: one record at 150 A held 1 s (not a stretch). Right: two records at 90 A over 1 s.
    [L.supply]: [[0, 5], [20, 150], [21, 5]],
    [R.supply]: [[0, 5], [30, 90], [30.5, 90], [31, 5]],
  } })
  expect(finding.evidence['worst motor']).toBe('Roller right')
  expect(finding.evidence['seconds over 120 % of the limit (worst motor)']).toBe(1)
})

test('[LN-04] a stretch over the limit counts however far over it goes, and the stretches are not added up', () => {
  // Five 0.15 s bursts at 90 A, 0.75 s in all: none longer than 0.2 s.
  const bursts: Trace = [[0, 5]]
  for (let t = 20; t < 25; t += 1) bursts.push([t, 90], [t + 0.15, 5])
  expect(run({ keys: { [L.supply]: bursts } }).findings).toEqual([])
})

test('[LN-05] only enabled time counts: current over the limit while disabled, or clipped to under 0.2 s by the enable, is not a finding', () => {
  expect(run({ keys: { [L.supply]: [[0, 5], [2, 90], [5, 90], [8, 5]] } }).findings).toEqual([])
  // 90 A from 109.9 s to 112 s: 0.1 s of it enabled.
  expect(run({ keys: { [L.supply]: [[0, 5], [109.9, 90], [110.95, 90], [112, 5]] } }).findings).toEqual([])
  // 90 A from 9.5 s to 10.5 s: 0.5 s of it enabled, from the enable at 10 s.
  expect(only({ keys: { [L.supply]: [[0, 5], [9.5, 90], [10.1, 90], [10.3, 90], [10.5, 5]] } }).time).toBe(10)
})

test('[LN-06] time after a motor\'s Connected flag goes false is not counted: its last current is held, not drawn', () => {
  // The left motor logs 90 A at 20 s and nothing more; it drops off CAN at 20.1 s.
  const dropped = { [L.supply]: [[0, 5], [20, 90]] as Trace, [L.connected]: [[0, true], [20.1, false]] as Trace }
  expect(run({ keys: dropped }).findings).toEqual([])
  // Back on CAN at 30 s, logging 90 A again at 31 s and 32 s (a held value alone is no record, LN-04): counted again from there.
  expect(only({ keys: { [L.supply]: [[0, 5], [20, 90], [31, 90], [32, 90]], [L.connected]: [[0, true], [20.1, false], [30, true]] } }).time).toBe(30)
})

test('[LN-06] a motor with no Connected flag, in the profile or in the log, counts all of its enabled time', () => {
  const held = { [L.supply]: [[0, 5], [20, 90], [21, 90]] as Trace }
  expect(only({ keys: held }).evidence['seconds over 120 % of the limit (worst motor)']).toBe(90)
  expect(only({ keys: held }, robot({}, [motor('Left', { connected: false }), motor('Right')])).evidence['seconds over 120 % of the limit (worst motor)']).toBe(90)
  expect(run({ keys: held }).skipped).toBeUndefined()
})

test('[LN-07] one finding per kind: the motor whose qualifying stretch went highest, at that stretch\'s start', () => {
  const f = only({ keys: {
    [L.supply]: [[0, 5], [20, 70], [20.5, 70], [21, 5], [40, 80], [40.5, 80], [41, 5]],
    [R.supply]: [[0, 5], [30, 95], [30.25, 95], [30.5, 5], [50, 99], [50.05, 99], [50.1, 5]],
  } })
  // The right motor's 99 A lasted 0.1 s, so it doesn't qualify; its 95 A stretch beats the left's 80 A.
  expect(f.evidence['worst motor']).toBe('Roller right')
  expect(f.time).toBe(30)
  expect(f.evidence['peak supply current (A)']).toBe(95)
})

test('[LN-07] the peak is the stretch\'s largest value, and the seconds are all of that motor\'s qualifying stretches', () => {
  const f = only({ keys: { [L.supply]: [[0, 5], [20, 60], [20.3, 88.84], [20.45, 88.84], [20.6, 5], [40, 70], [40.6, 70], [41.2, 5], [60, 90], [60.05, 90], [60.1, 5]] } })
  expect(f.evidence['peak supply current (A)']).toBe(88.8)
  expect(f.time).toBe(20)
  // 0.6 s + 1.2 s; the 0.1 s stretch is too short to count.
  expect(f.evidence['seconds over 120 % of the limit (worst motor)']).toBe(1.8)
})

test('[LN-07] on a tie the first motor in the profile\'s order is the worst motor', () => {
  const f = only({ keys: { [L.supply]: [[0, 5], [40, 90], [40.5, 90], [41, 5]], [R.supply]: [[0, 5], [20, 90], [20.5, 90], [21, 5]] } })
  expect(f.evidence['worst motor']).toBe('Roller left')
  expect(f.time).toBe(40)
})

test('[LN-08] the finding\'s title, word for word, when the log ran the profile\'s commit', () => {
  expect(only(leftSupply(90.4)).title).toBe('Roller supply current reached 90 A against a 40 A limit')
  expect(only(leftSupply(90.4), robot({ supplyA: 37.5 })).title).toBe('Roller supply current reached 90 A against a 37.5 A limit')
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 150.6], [20.5, 150.6], [21, 5]] } }, robot({ statorEnabled: false })).title)
    .toBe('Roller stator current reached 151 A against a 60 A limit that is switched off in code (deliberate?)')
})

test('[LN-09] a limit switched on in the code the log ran and still exceeded is red; in code that may differ it is amber, unknown', () => {
  expect(only(leftSupply(90)).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'same', files: ['RollerIO.java'] }).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }).severity).toBe('warning')
})

test('[LN-09] a limit switched off in the code this log ran is amber; switched off in other code is amber too, and unknown', () => {
  const off = robot({ supplyEnabled: false })
  expect(only(leftSupply(90), off).severity).toBe('warning')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, off, { verdict: 'same', files: ['RollerIO.java'] }).severity).toBe('warning')
  for (const lines of [{ verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: x'], ran: { why: 'no limits' } } as LimitLines, { verdict: 'unknown', why: 'no folder' } as LimitLines, undefined]) {
    const f = only({ ...leftSupply(90), ran: 'def5678' }, off, lines)
    expect(f.severity).toBe('warning')
    expect(f.title).toContain('the limit this build set is unknown')
  }
  expect(only({ ...leftSupply(90), ran: '' }, off).title).toContain('this log ran unknown code')
})

test('[LN-09] the log ran the profile\'s commit when its commit starts with the profile\'s (a longer hash counts)', () => {
  expect(only({ ...leftSupply(90), ran: `${PIN}9f9f9f9f` }, robot({ supplyEnabled: false })).severity).toBe('warning')
  expect(only({ ...leftSupply(90), ran: `${PIN}9f9f9f9f` }).title).toBe('Roller supply current reached 90 A against a 40 A limit')
})

const causeView = (f: Finding) => f.causes.map((c) => [c.id, c.likely ?? false, c.ruledOut ?? null])
const OFF_STEP = 'Switch the supply limit on in RollerIO.java:12-15, then measure the mechanism before and after. Off on purpose? Mark it as a known issue.'

test('[LN-10] switched off: the likely cause is limit-off, and the next step says where to switch it on, whatever code the log ran', () => {
  for (const f of [only(leftSupply(90), robot({ supplyEnabled: false })), only({ ...leftSupply(90), ran: 'def5678' }, robot({ supplyEnabled: false }), { verdict: 'same', files: ['RollerIO.java'] })]) {
    expect(causeView(f)).toEqual([['limit-off', true, null], ['not-saved', false, null], ['default-limit', false, null], ['wrong-value', false, null]])
    expect(f.nextStep).toBe(OFF_STEP)
  }
})

test('[LN-10] switched on in the code the log ran: not-saved and default-limit are likely and limit-off is ruled out', () => {
  for (const f of [only(leftSupply(90)), only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'same', files: ['RollerIO.java'] })]) {
    expect(causeView(f)).toEqual([['not-saved', true, null], ['default-limit', true, null], ['wrong-value', false, null], ['limit-off', false, 'the limit is switched on in the code']])
    expect(f.nextStep).toBe(limitNotApplied.nextStep)
  }
})

test('[LN-10] a build whose limit is unknown: no cause is marked, and the next step is to link the code', () => {
  const f = only({ ...leftSupply(90), ran: 'def5678' })
  expect(causeView(f)).toEqual([['limit-off', false, null], ['not-saved', false, null], ['default-limit', false, null], ['wrong-value', false, null]])
  expect(f.nextStep).toBe('Link the code this log ran (This laptop… → GitHub source, or a robot-code folder) so Hindsight reads its limit.')
})

/** The profile gives the supply limit's number but leaves its Enable flag out. */
const noFlag = () => robot({ supplyEnabled: undefined })

test('[LN-08] a limit whose Enable flag the profile leaves out: the title doesn\'t say it is switched off', () => {
  expect(only(leftSupply(90), noFlag()).title).toBe('Roller supply current reached 90 A against a 40 A limit')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, noFlag(), { verdict: 'same', files: ['RollerIO.java'] }).title).toBe('Roller supply current reached 90 A against a 40 A limit (same current-limit lines as main abc1234; this log ran def5678)')
})

test('[LN-09] a limit whose Enable flag the profile leaves out is red when the log ran the profile\'s code', () => {
  expect(only(leftSupply(90), noFlag()).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, noFlag(), { verdict: 'same', files: ['RollerIO.java'] }).severity).toBe('error')
})

test('[LN-10] a limit whose Enable flag the profile leaves out: no cause is marked or ruled out, and the rule\'s own next step, whenever it ran the profile\'s code', () => {
  const runs = [only(leftSupply(90), noFlag()), only({ ...leftSupply(90), ran: 'def5678' }, noFlag(), { verdict: 'same', files: ['RollerIO.java'] })]
  for (const f of runs) {
    expect(causeView(f)).toEqual([['limit-off', false, null], ['not-saved', false, null], ['default-limit', false, null], ['wrong-value', false, null]])
    expect(f.nextStep).toBe(limitNotApplied.nextStep)
  }
})

const LINES = "current-limit lines vs the profile's commit"
const SWITCHED = 'limit switched on in code'

test('[LN-11] the log ran the pinned commit: nothing is added to the title, and no lines comparison is shown or used', () => {
  const f = only(leftSupply(90), robot(), { verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: x'], ran: { why: 'no limits' } })
  expect(f.title).toBe('Roller supply current reached 90 A against a 40 A limit')
  expect(f.evidence[SWITCHED]).toBe('yes')
  expect(f.evidence[LINES]).toBeUndefined()
  expect(f.severity).toBe('error')
})

test('[LN-11] another commit with the same limit lines: the title and evidence say so, with the files', () => {
  const f = only({ ...leftSupply(90), ran: 'def5678aaaa' }, robot({ supplyEnabled: false }), { verdict: 'same', files: ['RollerIO.java', 'Constants.java'] })
  expect(f.title).toBe('Roller supply current reached 90 A against a 40 A limit that is switched off in code (deliberate?) (same current-limit lines as main abc1234; this log ran def5678)')
  expect(f.evidence[SWITCHED]).toBe('no (same current-limit lines as main abc1234; this log ran def5678)')
  expect(f.evidence[LINES]).toBe('the same as abc1234 in RollerIO.java, Constants.java (read from the robot code)')
})

test('[LN-11] another commit with different lines, lines not compared, or no code folder: the build\'s limit is unknown, with the profile\'s commit named', () => {
  const unknownTitle = "Roller supply current reached 90 A; the limit this build set is unknown (the profile's 40 A, on, is as of main abc1234; this log ran def5678)"
  const different = only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: a = 1;', '+ RollerIO.java: a = 2;'], ran: { why: 'the code gives its motors different limits' } })
  expect(different.title).toBe(unknownTitle)
  expect(different.evidence[SWITCHED]).toBe('yes (as of main abc1234; this log ran def5678)')
  expect(different.evidence[LINES]).toBe("different from abc1234: - RollerIO.java: a = 1;; + RollerIO.java: a = 2;; the limits this log's commit sets couldn't be read: the code gives its motors different limits")
  const unknown = only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'unknown', why: "commit def5678 isn't in this code folder" })
  expect(unknown.title).toBe(unknownTitle)
  expect(unknown.evidence[LINES]).toBe("not compared: commit def5678 isn't in this code folder")
  const none = only({ ...leftSupply(90), ran: 'def5678' })
  expect(none.title).toBe(unknownTitle)
  expect(none.evidence[LINES]).toBeUndefined()
})

test('[LN-11] a log with no commit says "unknown code"', () => {
  expect(only({ ...leftSupply(90), ran: '' }).title).toBe("Roller supply current reached 90 A; the limit this build set is unknown (the profile's 40 A, on, is as of main abc1234; this log ran unknown code)")
})

test('[LN-12] the evidence: its keys in order, and each value', () => {
  const f = only({ keys: { [L.supply]: [[0, 5], [20, 60], [20.5, 90.44], [21, 5]], [R.supply]: [[0, 5], [30, 45], [31, 5]] } })
  expect(Object.entries(f.evidence)).toEqual([
    ['worst motor', 'Roller left'],
    ['peak supply current (A)', 90.4],
    ['seconds over 120 % of the limit (worst motor)', 1],
    ['share of enabled time over 110 % of the limit (worst motor) (%)', 1],
    ['configured limit (A)', 40],
    [SWITCHED, 'yes'],
    ['set in', 'RollerIO.java:12-15'],
  ])
  const stator = only({ keys: { [R.stator]: [[0, 5], [20, 99.96], [20.15, 99.96], [20.3, 5]] } })
  expect(Object.keys(stator.evidence)).toContain('peak stator current (A)')
  expect(stator.evidence['peak stator current (A)']).toBe(100)
  expect(stator.evidence['configured limit (A)']).toBe(60)
})

test('[LN-12] the seconds over are rounded to one decimal', () => {
  expect(only(leftSupply(90, 20, 20.26)).evidence['seconds over 120 % of the limit (worst motor)']).toBe(0.3)
})

test('[LN-12] a limit whose Enable flag the profile leaves out: the evidence says it is not set in the profile', () => {
  expect(only(leftSupply(90), noFlag()).evidence[SWITCHED]).toBe('not set in the profile')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, noFlag()).evidence[SWITCHED]).toBe('not set in the profile')
})

test('[LN-08][LN-09][LN-10][LN-12] a stator limit whose Enable flag the profile leaves out is read the same way', () => {
  const stator = only({ keys: { [R.stator]: [[0, 5], [20, 150], [20.5, 150], [21, 5]] } }, robot({ statorEnabled: undefined }))
  expect(stator.title).toBe('Roller stator current reached 150 A against a 60 A limit')
  expect(stator.severity).toBe('error')
  expect(stator.evidence[SWITCHED]).toBe('not set in the profile')
  expect(causeView(stator)).toEqual([['limit-off', false, null], ['not-saved', false, null], ['default-limit', false, null], ['wrong-value', false, null]])
})

test('[LN-12][LN-13] the share is the worst motor\'s own, counting even one-sample blips, even when another motor spent longer over 110 %', () => {
  // Enabled 100 s. Left: 44.5 A (111 %) for 0.1 s five times = 0.5 s, then 90 A for 1 s. Right: 45 A for 2 s.
  const blips: Trace = [[0, 5]]
  for (let t = 20; t < 25; t += 1) blips.push([t, 44.5], [t + 0.1, 5])
  blips.push([40, 90], [40.5, 90], [41, 5])
  const f = only({ keys: { [L.supply]: blips, [R.supply]: [[0, 5], [60, 45], [61, 45], [62, 5]] } })
  expect(f.evidence['worst motor']).toBe('Roller left')
  // The left motor's 1.5 %, not the right motor's 2 %: the evidence says "(worst motor)".
  expect(f.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(1.5)
})

test('[LN-13] the share is the worst motor\'s, whichever place it has in the profile', () => {
  // Left (first) is the worst motor: 90 A for 3 s, 3 % of the 100 s enabled. Right: 45 A for 1 s, 1 %.
  const first = only({ keys: { [L.supply]: [[0, 5], [20, 90], [21.5, 90], [23, 5]], [R.supply]: [[0, 5], [40, 45], [40.5, 45], [41, 5]] } })
  expect(first.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(3)
  // Right (second) is the worst motor: 90 A for 1 s, 1 %. Left: 45 A for 3 s, 3 %.
  const second = only({ keys: { [L.supply]: [[0, 5], [20, 45], [21.5, 45], [23, 5]], [R.supply]: [[0, 5], [40, 90], [40.5, 90], [41, 5]] } })
  expect(second.evidence['worst motor']).toBe('Roller right')
  expect(second.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(1)
})

test('[LN-13] the share counts only enabled, connected time over strictly 110 %, out of all the enabled time', () => {
  // Enabled 10-60 s and 70-120 s: 100 s. Left (the worst motor) at exactly 110 % (44 A) from 20 s to 40 s: not over.
  // Then at 90 A from 50 s to 80 s: 10 s + 10 s enabled, less 1 s off CAN at 75 s. Right at 44 A the whole time.
  const f = only({
    enabled: [[10, 60], [70, 120]],
    keys: { [L.supply]: [[0, 5], [20, 44], [30, 44], [40, 5], [50, 90], [55, 90], [71, 90], [72, 90], [77, 90], [78, 90], [80, 5]], [L.connected]: [[0, true], [75, false], [76, true]], [R.supply]: [[0, 44]] },
  })
  expect(f.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(19)
})

test('[LN-13] the share is evidence only: no motor above 120 % for 0.2 s, no finding, however long it spent over 110 %', () => {
  expect(run({ keys: { [L.supply]: [[0, 5], [20, 47.9], [60, 47.9], [100, 5]] } }).findings).toEqual([])
})

test('[LN-14] the number judged: the peak in whole amps against 120 % of the limit', () => {
  expect(only(leftSupply(90.6)).measured).toEqual([{ label: 'peak supply current', value: 91, unit: 'A', threshold: 48 }])
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 99.4], [20.5, 99.4], [21, 5]] } }, robot({ statorA: 62 })).measured)
    .toEqual([{ label: 'peak stator current', value: 99, unit: 'A', threshold: 74 }])
})

test('[LN-15] the plot: every motor\'s current of that kind, from 2 s before to 4 s after, with the limit drawn', () => {
  const f = only(leftSupply(90, 30, 31))
  expect(f.plot).toMatchObject({ unit: 'A', from: 28, to: 34, threshold: { value: 40, label: '40 A limit' } })
  expect(f.plot!.lines.map((l) => l.label)).toEqual(['Roller left supply', 'Roller right supply'])
  const stator = only({ keys: { [R.stator]: [[0, 5], [50, 99], [50.5, 99], [51, 5]] } })
  expect(stator.plot!.lines.map((l) => l.label)).toEqual(['Roller left stator', 'Roller right stator'])
  expect(stator.plot).toMatchObject({ from: 48, to: 54, threshold: { value: 60, label: '60 A limit' } })
})

test('[LN-16] a motor whose current isn\'t in the log: the group is not checked, naming the key', () => {
  const { findings, skipped } = run({ keys: { [R.supply]: [] } })
  expect(findings).toEqual([])
  expect(skipped).toBe('Roller: missing /Roller/Right/SupplyCurrentAmps')
  expect(run({ keys: { [R.stator]: [] } }, robot({ supplyA: undefined })).skipped).toBe('Roller: missing /Roller/Right/StatorCurrentAmps')
  // The profile names no key: the line says so, with the motor.
  const { supplyCurrent: _, ...noKey } = motor('Left')
  expect(run(leftSupply(90), robot({}, [noKey, motor('Right')])).skipped).toBe('Roller: missing Roller left supply current (not in the robot profile)')
})

test('[LN-17] current is judged by its size: a negative current past the limit counts', () => {
  const f = only({ keys: { [R.stator]: [[0, 5], [20, -95.5], [20.5, -95.5], [21, 5]] } })
  expect(f.evidence['peak stator current (A)']).toBe(95.5)
  expect(f.title).toBe('Roller stator current reached 96 A against a 60 A limit')
})

test('[LN-18] a fault: a finding in a run under 10 s is kept', () => {
  expect(only({ enabled: [[10, 15]], keys: { [L.supply]: [[0, 5], [11, 90], [11.5, 90], [12, 5]] } }).time).toBe(11)
})

test('[LN-19] the descriptor follows the rule format: every prose field said, two measured thresholds and one chosen, CTRE\'s pages cited', () => {
  const r = limitNotApplied
  for (const text of [r.meaning, r.nextStep, r.incident, ...r.causes.flatMap((c) => [c.cause, c.look])]) expect(text.trim()).not.toBe('')
  expect(r.thresholds!.map((t) => t.basis)).toEqual(['measured', 'judgment', 'measured'])
  for (const t of r.thresholds!) {
    for (const text of [t.name, t.value, t.how]) expect(text.trim()).not.toBe('')
  }
  const catalog = Object.values(SOURCES).filter((x) => typeof x === 'object' && x !== null && 'url' in x)
  expect(r.sources.length).toBeGreaterThan(0)
  for (const { says, ...page } of r.sources) {
    expect(catalog).toContainEqual(page)
    expect(page.url).toMatch(/^https:\/\/[a-z0-9.-]*ctr-electronics\.com\//)
    expect(says.trim()).not.toBe('')
  }
})

test('[LN-20] an error other than a missing signal is not swallowed: the rule crashes, so the bug shows', () => {
  const view = new MatchView(matchOf(leftSupply(90)))
  const group = motorGroup(robot().motorGroups[0], view)
  group.motors[0] = { ...group.motors[0], connected: () => { throw new Error('a bug in a signal read') } }
  expect(() => limitNotApplied.check(group, view)).toThrow('a bug in a signal read')
})

test('[LN-21] a Connected flag that flickers many times costs time in proportion, not in doubling', () => {
  // 40 drops off CAN, 0.1 s each, while the left motor is held at 90 A from 15 s to 17 s.
  const flicker: Trace = [[0, true]]
  for (let i = 0; i < 40; i++) flicker.push([20 + i * 0.2, false], [20.1 + i * 0.2, true])
  expect(only({ keys: { [L.supply]: [[0, 5], [15, 90], [16, 90], [17, 5]], [L.connected]: flicker } }).time).toBe(15)
}, 5_000)

// The limit the log's own commit sets (docs/contracts/limit-not-applied.md LN-22): when the CurrentLimit lines differ
// from the profile's commit, the comparison also says what limits the log's commit sets (`ran`).
const RAN = 'fed4321aaaa'
const differs = (ran: Extract<LimitLines, { verdict: 'different' }>['ran']): LimitLines => ({ verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: x', '+ RollerIO.java: y'], ran })
const sets = (limits: Partial<CurrentLimits>) => differs({ commit: RAN, limits: { where: 'RollerIO.java:30-31', ...limits } })
const sustained = (amps: number): Log => ({ ...leftSupply(amps, 20, 21), ran: RAN })
const UNKNOWN_STEP = 'Link the code this log ran (This laptop… → GitHub source, or a robot-code folder) so Hindsight reads its limit.'

test('[LN-22] the log\'s commit sets 55 A, on: a peak under 120 % of 55 A is no finding, though it is over the profile\'s 40 A', () => {
  expect(run(sustained(65), robot(), sets({ supplyA: 55, supplyEnabled: true })).findings).toEqual([])
})

test('[LN-22] the log\'s commit sets 55 A, on, and 80 A is sustained: red against 55 A, naming the log\'s commit as the source', () => {
  const f = only(sustained(80), robot(), sets({ supplyA: 55, supplyEnabled: true }))
  expect(f.title).toBe("Roller supply current reached 80 A against a 55 A limit (as this log's commit fed4321 sets it)")
  expect(f.severity).toBe('error')
  expect(f.evidence['configured limit (A)']).toBe(55)
  expect(f.evidence[SWITCHED]).toBe("yes (as this log's commit fed4321 sets it)")
  expect(f.measured).toEqual([{ label: 'peak supply current', value: 80, unit: 'A', threshold: 66 }])
  expect(causeView(f)).toEqual([['not-saved', true, null], ['default-limit', true, null], ['wrong-value', false, null], ['limit-off', false, 'the limit is switched on in the code']])
  expect(f.nextStep).toBe(limitNotApplied.nextStep)
})

test('[LN-22] the log\'s commit sets the limit off: amber, deliberate?, limit-off likely', () => {
  const f = only(sustained(80), robot(), sets({ supplyA: 55, supplyEnabled: false }))
  expect(f.title).toBe("Roller supply current reached 80 A against a 55 A limit that is switched off in code (deliberate?) (as this log's commit fed4321 sets it)")
  expect(f.severity).toBe('warning')
  expect(causeView(f)[0]).toEqual(['limit-off', true, null])
  expect(f.nextStep).toBe(OFF_STEP.replace('RollerIO.java:12-15', 'RollerIO.java:30-31'))
})

test('[LN-22] the log\'s commit sets a limit but no Enable flag: red, no cause marked, as for a profile without the flag', () => {
  const f = only(sustained(80), robot(), sets({ supplyA: 55 }))
  expect(f.severity).toBe('error')
  expect(f.evidence[SWITCHED]).toBe('not set in the code')
  expect(causeView(f).map(([, likely]) => likely)).toEqual([false, false, false, false])
})

test('[LN-22] different lines and the log\'s limits unreadable: amber, the limit this build set is unknown, no cause marked', () => {
  const f = only(sustained(80), robot({ supplyEnabled: false }), differs({ why: 'the code sets no current limits on it that the builder can read' }))
  expect(f.title).toBe("Roller supply current reached 80 A; the limit this build set is unknown (the profile's 40 A, off, is as of main abc1234; this log ran fed4321)")
  expect(f.severity).toBe('warning')
  expect(causeView(f).map(([, likely]) => likely)).toEqual([false, false, false, false])
  expect(f.nextStep).toContain("couldn't read this build's limit from the linked code")
  expect(f.evidence[LINES]).toContain('the code sets no current limits on it that the builder can read')
})

test('[LN-22] another commit and no code linked, or lines not compared: amber and unknown, whatever the profile says', () => {
  const asOf = "the limit this build set is unknown (the profile's 40 A, on, is as of main abc1234; this log ran fed4321)"
  for (const lines of [undefined, { verdict: 'unknown', why: 'no folder' } as LimitLines]) {
    const f = only(sustained(80), robot(), lines)
    expect(f.title).toBe(`Roller supply current reached 80 A; ${asOf}`)
    expect(f.severity).toBe('warning')
    if (lines) expect(f.nextStep).toContain('linked code')
    else expect(f.nextStep).toBe(UNKNOWN_STEP)
  }
  // No flag in the profile: only the number.
  expect(only(sustained(80), noFlag()).title).toBe("Roller supply current reached 80 A; the limit this build set is unknown (the profile's 40 A is as of main abc1234; this log ran fed4321)")
  // The finding is still judged against the profile's number: 56 A is under 120 % of 55 A but over 120 % of 40 A.
  expect(only(sustained(56)).about).toBe('Roller supply')
})

test('[LN-22] a kind the log\'s commit does not set is unknown, while a kind it sets is judged against it', () => {
  const log: Log = { ran: RAN, keys: { [L.supply]: [[0, 5], [20, 80], [20.5, 80], [21, 5]], [R.stator]: [[0, 5], [30, 150], [30.5, 150], [31, 5]] } }
  const { findings } = run(log, robot(), sets({ supplyA: 55, supplyEnabled: true }))
  expect(findings.map((f) => [f.about, f.severity, f.title.includes('is unknown')])).toEqual([['Roller supply', 'error', false], ['Roller stator', 'warning', true]])
})

test('[LN-22] the same commit or the same lines still judge against the profile, whatever `ran` says', () => {
  expect(only({ ...leftSupply(90), ran: PIN }, robot(), sets({ supplyA: 200, supplyEnabled: true })).title).toBe('Roller supply current reached 90 A against a 40 A limit')
})

test('[LN-22] the unknown row\'s next step: link the code when none is linked; check the limit by hand when the linked code could not be read', () => {
  const linked = only(sustained(80), robot(), differs({ why: 'the code gives its motors different limits' }))
  expect(linked.nextStep).toBe("Hindsight couldn't read this build's limit from the linked code (why in the evidence): check the limit in RollerIO.java:12-15 at fed4321.")
  expect(only(sustained(80), robot(), { verdict: 'unknown', why: 'commit missing' }).nextStep).toContain("couldn't read this build's limit")
  expect(only(sustained(80)).nextStep).toBe(UNKNOWN_STEP)
  // A kind the log's commit doesn't set: linked code, so the same, and the evidence says what was missing.
  const { findings } = run({ ran: RAN, keys: { [R.stator]: [[0, 5], [30, 150], [30.5, 150], [31, 5]] } }, robot(), sets({ supplyA: 55, supplyEnabled: true }))
  expect(findings[0].evidence[LINES]).toMatch(/include no stator limit$/)
})
