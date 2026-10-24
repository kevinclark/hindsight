// A rule says "not checked", never quiet, when the thing it judges didn't happen in the match: a session counts a quiet
// match as clean ("not seen since"), so silence must mean "looked, and it was fine". Synthetic logs only.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { competition2026 } from '../src/profiles/2026-competition.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { writeWpilog, type Fixture, type FixtureEntry } from './helpers/fixture-format.ts'

const autoAndComms = JSON.parse(readFileSync('fixtures/auto-and-comms.json', 'utf8')) as Fixture

function report(entries: FixtureEntry[], profile: RobotProfile = offseason2026) {
  return analyzeFiles([{ name: 'TEST.wpilog', bytes: writeWpilog(entries) }], profile).analyses[0].report
}
/** The rule's "not checked" reason, and that it found nothing. */
function notChecked(r: ReturnType<typeof report>, rule: string): string | undefined {
  expect(r.findings.filter((f) => f.rule === rule)).toEqual([])
  return r.skipped.find((s) => s.rule === rule)?.reason
}
const flat = (name: string, value: number | boolean, type: FixtureEntry['type'] = 'double', from = 10, to = 200): FixtureEntry =>
  ({ name, type, records: Array.from({ length: Math.round((to - from) / 0.5) + 1 }, (_, i) => [from + i * 0.5, value]) }) as FixtureEntry

describe('a log with no match on the field (never enabled)', () => {
  const r = report([
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[10, false]] },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[10, true]] },
    flat('/SystemStats/BatteryVoltage', 12.6),
    flat('/SystemStats/BrownoutVoltage', 6.75),
    flat('/SystemStats/CommsDisableCount', 0, 'int64'),
    flat('/RealOutputs/LoggedRobot/FullCycleMS', 20),
  ])
  it.each([
    ['auto/early-disable', /not a match on the field/],
    ['auto/none-at-enable', /never enabled/],
    ['loop/restart-mid-match', /not a match on the field/],
    ['power/main-breaker-margin', /no match in this log/],
    ['power/margin', /the robot was never enabled/],
    ['power/rest-voltage', /the robot was never enabled/],
    ['comms/loss', /no match in this log/],
    ['loop/overrun', /the robot was never enabled/],
  ])('%s: not checked', (rule, reason) => {
    expect(notChecked(r, rule)).toMatch(reason)
  })
})

describe('mechanisms that never did the thing the rule judges', () => {
  const enabled = autoAndComms.entries.find((e) => e.name === '/DriverStation/Enabled')!.records.map(([t]) => t as number)
  const [from, to] = [Math.min(...enabled), Math.max(...enabled) + 20]
  const base = autoAndComms.entries.filter((e) => !['/Drum/Hood/PositionRotations', '/RealOutputs/Console'].includes(e.name))

  const hoodRun = (hood: FixtureEntry, consoleLines: [number, string][]) =>
    report([...base, hood, { name: '/RealOutputs/Console', type: 'string', records: consoleLines }])
  it('mech/zero-not-completed: the hood never moved, zeroed or not', () => {
    const still = flat('/Drum/Hood/PositionRotations', 2 / 360, 'double', from, to)
    expect(notChecked(hoodRun(still, [[from, 'Robot program startup complete']]), 'mech/zero-not-completed')).toMatch(/^Hood: it never moved while enabled/)
    // Zeroed at boot, before the first enable, then never moved: the match never tested the zero.
    expect(notChecked(hoodRun(still, [[from, 'Rezeroed hood']]), 'mech/zero-not-completed')).toMatch(/^Hood: it never moved while enabled/)
  })
  it('mech/zero-not-completed: zeroed at boot and moved later in the match reads quiet (the zero was in time)', () => {
    const moves = { name: '/Drum/Hood/PositionRotations', type: 'double', records: [[from, 2 / 360], [300, 2 / 360], [301, 30 / 360], [to, 30 / 360]] } as FixtureEntry // enabled 293–422 s
    const r = hoodRun(moves, [[from - 50, 'Rezeroed hood']])
    expect(notChecked(r, 'mech/zero-not-completed')).toBeUndefined()
  })
  it('mech/follower-mismatch: the flywheel leader never held a steady speed', () => {
    const flywheel = offseason2026.motorGroups.find((g) => g.sameLoop)!
    const r = report([...base, ...flywheel.motors.map((m) => flat(m.velocity!, 0, 'double', from, to))])
    // The other groups aren't same-loop: not this rule's business, so the whole rule is not checked, not "partly".
    expect(notChecked(r, 'mech/follower-mismatch')).toMatch(new RegExp(`^${flywheel.name}: the leader held a steady speed for only 0.0 s`))
  })
  it('mech/stall: a never-stalls motor that never turned', () => {
    const turret = competition2026.motorGroups.find((g) => g.neverStalls)!.motors[0]
    const r = report([...base, flat(turret.velocity!, 0, 'double', from, to), flat(turret.statorCurrent!, 0, 'double', from, to)], competition2026)
    expect(notChecked(r, 'mech/stall')).toMatch(new RegExp(`^${turret.name}: it never turned while enabled`))
  })
  it('`only`: a robot with no motor the rule is for reads not checked, not quiet', () => {
    expect(offseason2026.motorGroups.some((g) => g.neverStalls)).toBe(false)
    expect(notChecked(report(base), 'mech/stall')).toBe('the robot profile has no motor this rule is for')
  })
})
