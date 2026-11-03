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
/** The left motor's supply current at `amps` from `from` to `to` s, 5 A otherwise. */
const leftSupply = (amps: number, from = 20, to = 21): Log => ({ keys: { [L.supply]: [[0, 5], [from, amps], [to, 5]] } })

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
  const both = run({ keys: { [L.supply]: [[0, 5], [20, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [31, 5]] } })
  expect(both.findings.map((f) => f.about).sort()).toEqual(['Roller stator', 'Roller supply'])
  expect(both.skipped).toBeUndefined()
  const supplyOnly = run({ keys: { [L.supply]: [[0, 5], [20, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [31, 5]] } }, robot({ statorA: undefined }))
  expect(supplyOnly.findings.map((f) => f.about)).toEqual(['Roller supply'])
  expect(supplyOnly.skipped).toBeUndefined()
  const statorOnly = run({ keys: { [L.supply]: [[0, 5], [20, 90], [21, 5]], [R.stator]: [[0, 5], [30, 150], [31, 5]] } }, robot({ supplyA: undefined }))
  expect(statorOnly.findings.map((f) => f.about)).toEqual(['Roller stator'])
  // A kind with no limit isn't read at all: its currents missing from the log change nothing.
  const noStatorLogged = run({ keys: { [L.supply]: [[0, 5], [20, 90], [21, 5]], [L.stator]: [], [R.stator]: [] } }, robot({ statorA: undefined }))
  expect(noStatorLogged.findings.map((f) => f.about)).toEqual(['Roller supply'])
  expect(noStatorLogged.skipped).toBeUndefined()
})

test('[LN-04] it fires only above 120 % of the limit, not at it', () => {
  // 40 A limit: 120 % is exactly 48 A.
  expect(run(leftSupply(48)).findings).toEqual([])
  expect(only(leftSupply(48.01)).about).toBe('Roller supply')
  // 60 A stator limit: 72 A.
  expect(run({ keys: { [R.stator]: [[0, 5], [20, 72], [21, 5]] } }).findings).toEqual([])
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 72.01], [21, 5]] } }).about).toBe('Roller stator')
})

test('[LN-04] it fires only for a stretch longer than 0.2 s: exactly 0.2 s is the limiter catching up', () => {
  // 0.3 s to 0.5 s is exactly 0.2 s in floating point (10.3 s to 10.5 s is not).
  const early = (to: number): Log => ({ enabled: [[0.1, 110]], keys: { [L.supply]: [[0, 5], [0.3, 90], [to, 5]] } })
  expect(run(early(0.5)).findings).toEqual([])
  expect(only(early(0.500001)).time).toBeCloseTo(0.3, 6)
  expect(run(leftSupply(90, 20, 20.15)).findings).toEqual([])
  expect(only(leftSupply(90, 20, 20.25)).time).toBe(20)
})

test('[LN-04] a stretch over the limit counts however far over it goes, and the stretches are not added up', () => {
  // Five 0.15 s bursts at 90 A, 0.75 s in all: none longer than 0.2 s.
  const bursts: Trace = [[0, 5]]
  for (let t = 20; t < 25; t += 1) bursts.push([t, 90], [t + 0.15, 5])
  expect(run({ keys: { [L.supply]: bursts } }).findings).toEqual([])
})

test('[LN-05] only enabled time counts: current over the limit while disabled, or clipped to under 0.2 s by the enable, is not a finding', () => {
  expect(run({ keys: { [L.supply]: [[0, 5], [2, 90], [8, 5]] } }).findings).toEqual([])
  // 90 A from 109.9 s to 112 s: 0.1 s of it enabled.
  expect(run({ keys: { [L.supply]: [[0, 5], [109.9, 90], [112, 5]] } }).findings).toEqual([])
  // 90 A from 9.5 s to 10.5 s: 0.5 s of it enabled, from the enable at 10 s.
  expect(only({ keys: { [L.supply]: [[0, 5], [9.5, 90], [10.5, 5]] } }).time).toBe(10)
})

test('[LN-06] time after a motor\'s Connected flag goes false is not counted: its last current is held, not drawn', () => {
  // The left motor logs 90 A at 20 s and nothing more; it drops off CAN at 20.1 s.
  const dropped = { [L.supply]: [[0, 5], [20, 90]] as Trace, [L.connected]: [[0, true], [20.1, false]] as Trace }
  expect(run({ keys: dropped }).findings).toEqual([])
  // Back on CAN at 30 s, still reading the held 90 A: counted again from there.
  expect(only({ keys: { ...dropped, [L.connected]: [[0, true], [20.1, false], [30, true]] } }).time).toBe(30)
})

test('[LN-06] a motor with no Connected flag, in the profile or in the log, counts all of its enabled time', () => {
  const held = { [L.supply]: [[0, 5], [20, 90]] as Trace }
  expect(only({ keys: held }).evidence['seconds over 120 % of the limit (worst motor)']).toBe(90)
  expect(only({ keys: held }, robot({}, [motor('Left', { connected: false }), motor('Right')])).evidence['seconds over 120 % of the limit (worst motor)']).toBe(90)
  expect(run({ keys: held }).skipped).toBeUndefined()
})

test('[LN-07] one finding per kind: the motor whose qualifying stretch went highest, at that stretch\'s start', () => {
  const f = only({ keys: {
    [L.supply]: [[0, 5], [20, 70], [21, 5], [40, 80], [41, 5]],
    [R.supply]: [[0, 5], [30, 95], [30.5, 5], [50, 99], [50.1, 5]],
  } })
  // The right motor's 99 A lasted 0.1 s, so it doesn't qualify; its 95 A stretch beats the left's 80 A.
  expect(f.evidence['worst motor']).toBe('Roller right')
  expect(f.time).toBe(30)
  expect(f.evidence['peak supply current (A)']).toBe(95)
})

test('[LN-07] the peak is the stretch\'s largest value, and the seconds are all of that motor\'s qualifying stretches', () => {
  const f = only({ keys: { [L.supply]: [[0, 5], [20, 60], [20.3, 88.84], [20.6, 5], [40, 70], [41.2, 5], [60, 90], [60.1, 5]] } })
  expect(f.evidence['peak supply current (A)']).toBe(88.8)
  expect(f.time).toBe(20)
  // 0.6 s + 1.2 s; the 0.1 s stretch is too short to count.
  expect(f.evidence['seconds over 120 % of the limit (worst motor)']).toBe(1.8)
})

test('[LN-07] on a tie the first motor in the profile\'s order is the worst motor', () => {
  const f = only({ keys: { [L.supply]: [[0, 5], [40, 90], [41, 5]], [R.supply]: [[0, 5], [20, 90], [21, 5]] } })
  expect(f.evidence['worst motor']).toBe('Roller left')
  expect(f.time).toBe(40)
})

test('[LN-08] the finding\'s title, word for word, when the log ran the profile\'s commit', () => {
  expect(only(leftSupply(90.4)).title).toBe('Roller supply current reached 90 A against a 40 A limit')
  expect(only(leftSupply(90.4), robot({ supplyA: 37.5 })).title).toBe('Roller supply current reached 90 A against a 37.5 A limit')
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 150.6], [21, 5]] } }, robot({ statorEnabled: false })).title)
    .toBe('Roller stator current reached 151 A against a 60 A limit that is switched off in code (deliberate?)')
})

test('[LN-09] a limit switched on in code and still exceeded is red', () => {
  expect(only(leftSupply(90)).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'same', files: ['RollerIO.java'] }).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }).severity).toBe('error')
})

test('[LN-09] a limit switched off in the code this log ran is amber; switched off in other code it stays red', () => {
  const off = robot({ supplyEnabled: false })
  expect(only(leftSupply(90), off).severity).toBe('warning')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, off, { verdict: 'same', files: ['RollerIO.java'] }).severity).toBe('warning')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, off, { verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: x'] }).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, off, { verdict: 'unknown', why: 'no folder' }).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: 'def5678' }, off).severity).toBe('error')
  expect(only({ ...leftSupply(90), ran: '' }, off).severity).toBe('error')
})

test('[LN-09] the log ran the profile\'s commit when its commit starts with the profile\'s (a longer hash counts)', () => {
  expect(only({ ...leftSupply(90), ran: `${PIN}9f9f9f9f` }, robot({ supplyEnabled: false })).severity).toBe('warning')
  expect(only({ ...leftSupply(90), ran: `${PIN}9f9f9f9f` }).title).toBe('Roller supply current reached 90 A against a 40 A limit')
})

const causeView = (f: Finding) => f.causes.map((c) => [c.id, c.likely ?? false, c.ruledOut ?? null])
const OFF_STEP = 'The supply limit is switched off in RollerIO.java:12-15. On purpose? Mark it as a known issue. If not, switch it on and measure the mechanism before and after.'

test('[LN-10] switched off: the likely cause is limit-off, and the next step says where to switch it on, whatever code the log ran', () => {
  for (const f of [only(leftSupply(90), robot({ supplyEnabled: false })), only({ ...leftSupply(90), ran: 'def5678' }, robot({ supplyEnabled: false }))]) {
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

test('[LN-10] switched on in code the profile wasn\'t copied from: no cause is marked, and the rule\'s own next step', () => {
  const f = only({ ...leftSupply(90), ran: 'def5678' })
  expect(causeView(f)).toEqual([['limit-off', false, null], ['not-saved', false, null], ['default-limit', false, null], ['wrong-value', false, null]])
  expect(f.nextStep).toBe(limitNotApplied.nextStep)
})

const LINES = "current-limit lines vs the profile's commit"
const SWITCHED = 'limit switched on in code'

test('[LN-11] the log ran the profile\'s commit: nothing is added to the title, and no lines comparison is shown or read', () => {
  const f = only(leftSupply(90), robot(), { verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: x'] })
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

test('[LN-11] another commit with different lines, lines not compared, or no code folder: "as of" the profile\'s commit', () => {
  const asOf = ' (as of main abc1234; this log ran def5678)'
  const different = only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'different', files: ['RollerIO.java'], lines: ['- RollerIO.java: a = 1;', '+ RollerIO.java: a = 2;'] })
  expect(different.title).toBe(`Roller supply current reached 90 A against a 40 A limit${asOf}`)
  expect(different.evidence[SWITCHED]).toBe(`yes${asOf}`)
  expect(different.evidence[LINES]).toBe('different from abc1234: - RollerIO.java: a = 1;; + RollerIO.java: a = 2;')
  const unknown = only({ ...leftSupply(90), ran: 'def5678' }, robot(), { verdict: 'unknown', why: "commit def5678 isn't in this code folder" })
  expect(unknown.title).toBe(`Roller supply current reached 90 A against a 40 A limit${asOf}`)
  expect(unknown.evidence[LINES]).toBe("not compared: commit def5678 isn't in this code folder")
  const none = only({ ...leftSupply(90), ran: 'def5678' })
  expect(none.title).toBe(`Roller supply current reached 90 A against a 40 A limit${asOf}`)
  expect(none.evidence[LINES]).toBeUndefined()
})

test('[LN-11] a log with no commit says "unknown code"', () => {
  expect(only({ ...leftSupply(90), ran: '' }).title).toBe('Roller supply current reached 90 A against a 40 A limit (as of main abc1234; this log ran unknown code)')
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
  const stator = only({ keys: { [R.stator]: [[0, 5], [20, 99.96], [20.3, 5]] } })
  expect(Object.keys(stator.evidence)).toContain('peak stator current (A)')
  expect(stator.evidence['peak stator current (A)']).toBe(100)
  expect(stator.evidence['configured limit (A)']).toBe(60)
})

test('[LN-12] the seconds over are rounded to one decimal', () => {
  expect(only(leftSupply(90, 20, 20.26)).evidence['seconds over 120 % of the limit (worst motor)']).toBe(0.3)
})

test('[LN-13] the share is the largest share of enabled time any motor spent over 110 %, counting even one-sample blips', () => {
  // Enabled 100 s. Left: 44.5 A (111 %) for 0.1 s five times = 0.5 s, then 90 A for 1 s. Right: 45 A for 2 s.
  const blips: Trace = [[0, 5]]
  for (let t = 20; t < 25; t += 1) blips.push([t, 44.5], [t + 0.1, 5])
  blips.push([40, 90], [41, 5])
  const f = only({ keys: { [L.supply]: blips, [R.supply]: [[0, 5], [60, 45], [62, 5]] } })
  expect(f.evidence['worst motor']).toBe('Roller left')
  // The right motor's 2 % beats the left's 1.5 %: the share can name another motor than the worst motor.
  expect(f.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(2)
})

test('[LN-13] the share is the largest, whichever motor comes first in the profile', () => {
  // Left (first): 90 A for 3 s, 3 % of the 100 s enabled. Right: 45 A for 1 s, 1 %.
  const f = only({ keys: { [L.supply]: [[0, 5], [20, 90], [23, 5]], [R.supply]: [[0, 5], [40, 45], [41, 5]] } })
  expect(f.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(3)
})

test('[LN-13] the share counts only enabled, connected time over strictly 110 %, out of all the enabled time', () => {
  // Enabled 10-60 s and 70-120 s: 100 s. Left at 90 A from 50 s to 80 s: 10 s + 10 s enabled, less 1 s off CAN at
  // 75 s. Right at exactly 110 % (44 A) the whole time: not over.
  const f = only({
    enabled: [[10, 60], [70, 120]],
    keys: { [L.supply]: [[0, 5], [50, 90], [80, 5]], [L.connected]: [[0, true], [75, false], [76, true]], [R.supply]: [[0, 44]] },
  })
  expect(f.evidence['share of enabled time over 110 % of the limit (worst motor) (%)']).toBe(19)
})

test('[LN-13] the share is evidence only: no motor above 120 % for 0.2 s, no finding, however long it spent over 110 %', () => {
  expect(run({ keys: { [L.supply]: [[0, 5], [20, 47.9], [100, 5]] } }).findings).toEqual([])
})

test('[LN-14] the number judged: the peak in whole amps against 120 % of the limit', () => {
  expect(only(leftSupply(90.6)).measured).toEqual([{ label: 'peak supply current', value: 91, unit: 'A', threshold: 48 }])
  expect(only({ keys: { [R.stator]: [[0, 5], [20, 99.4], [21, 5]] } }, robot({ statorA: 62 })).measured)
    .toEqual([{ label: 'peak stator current', value: 99, unit: 'A', threshold: 74 }])
})

test('[LN-15] the plot: every motor\'s current of that kind, from 2 s before to 4 s after, with the limit drawn', () => {
  const f = only(leftSupply(90, 30, 31))
  expect(f.plot).toMatchObject({ unit: 'A', from: 28, to: 34, threshold: { value: 40, label: '40 A limit' } })
  expect(f.plot!.lines.map((l) => l.label)).toEqual(['Roller left supply', 'Roller right supply'])
  const stator = only({ keys: { [R.stator]: [[0, 5], [50, 99], [51, 5]] } })
  expect(stator.plot!.lines.map((l) => l.label)).toEqual(['Roller left stator', 'Roller right stator'])
  expect(stator.plot).toMatchObject({ from: 48, to: 54, threshold: { value: 60, label: '60 A limit' } })
})

test('[LN-16] a motor whose current isn\'t in the log: the group is not checked, naming the key', () => {
  const { findings, skipped } = run({ keys: { [R.supply]: [] } })
  expect(findings).toEqual([])
  expect(skipped).toBe('Roller: missing /Roller/Right/SupplyCurrentAmps')
  expect(run({ keys: { [R.stator]: [] } }, robot({ supplyA: undefined })).skipped).toBe('Roller: missing /Roller/Right/StatorCurrentAmps')
})

test('[LN-17] current is judged by its size: a negative current past the limit counts', () => {
  const f = only({ keys: { [R.stator]: [[0, 5], [20, -95.5], [21, 5]] } })
  expect(f.evidence['peak stator current (A)']).toBe(95.5)
  expect(f.title).toBe('Roller stator current reached 96 A against a 60 A limit')
})

test('[LN-18] a fault: a finding in a run under 10 s is kept', () => {
  expect(only({ enabled: [[10, 15]], keys: { [L.supply]: [[0, 5], [11, 90], [12, 5]] } }).time).toBe(11)
})

test('[LN-19] the descriptor follows the rule format: every prose field said, two measured thresholds, CTRE\'s pages cited', () => {
  const r = limitNotApplied
  for (const text of [r.meaning, r.nextStep, r.incident, ...r.causes.flatMap((c) => [c.cause, c.look])]) expect(text.trim()).not.toBe('')
  expect(r.thresholds).toHaveLength(2)
  for (const t of r.thresholds!) {
    expect(t.basis).toBe('measured')
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
