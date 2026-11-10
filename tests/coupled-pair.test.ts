// Coupled pairs (MotorGroup.coupledPairs) and mech/pair-decoupled, on made-up logs for the 2026 offseason robot's kicker.
// The real cases are 8033's own logs (tests/helpers/team-logs.ts, pitEvent2026Files); their numbers are in the rule's header.
import { describe, expect, it } from 'vitest'
import { offseason2026, offseason2026Event } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

describe('coupled pairs in the 2026 offseason profiles', () => {
  for (const profile of [offseason2026, offseason2026Event]) {
    it(`${profile.name} (${profile.code.branch}) names the kicker pair, each motor with its velocity key`, () => {
      const groups = profile.motorGroups.filter((g) => g.coupledPairs?.length)
      expect(groups).toHaveLength(1)
      const [group] = groups
      expect(group.coupledPairs).toEqual([{ name: 'Kicker', leader: 'Kicker leader', follower: 'Kicker follower', where: expect.stringMatching(/IndexerIO\.java/) }])
      const motor = (name: string) => group.motors.find((m) => m.name === name)
      expect(motor('Kicker leader')?.velocity).toBe('/Indexer/KickerLeaderVelocityRotationsPerSec')
      expect(motor('Kicker follower')?.velocity).toBe('/Indexer/KickerFollowerVelocityRotationsPerSec')
    })
  }
})


const LEADER = '/Indexer/KickerLeaderVelocityRotationsPerSec'
const FOLLOWER = '/Indexer/KickerFollowerVelocityRotationsPerSec'
const LEADER_AMPS = '/Indexer/KickerLeaderStatorCurrentAmp'
const FOLLOWER_AMPS = '/Indexer/KickerFollowerStatorCurrentAmp'

/** Enabled 20 to 60 s; every signal logged every 20 ms from 20 to 60 s, its value a function of time. */
function kickerLog(leader: (t: number) => number, follower: (t: number) => number, leaderAmps: (t: number) => number = () => 5,
  followerAmps: (t: number) => number = () => 5, opts: { skip?: (t: number) => boolean; skipFollower?: (t: number) => boolean; enabled?: FixtureEntry; noCurrents?: boolean; extra?: FixtureEntry[] } = {}) {
  const every20ms = (name: string, value: (t: number) => number): FixtureEntry => {
    const records: [number, number][] = []
    for (let i = 0; i <= 2000; i++) { const t = 20 + i * 0.02; if (!opts.skip?.(t)) records.push([t, value(t)]) }
    return { name, type: 'double', records }
  }
  const entries: FixtureEntry[] = [
    opts.enabled ?? { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [60, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.5], [70, 12.5]] },
    every20ms(LEADER, leader),
    { ...every20ms(FOLLOWER, follower), records: every20ms(FOLLOWER, follower).records.filter(([t]) => !opts.skipFollower?.(t)) },
    ...(opts.noCurrents ? [] : [every20ms(LEADER_AMPS, leaderAmps), every20ms(FOLLOWER_AMPS, followerAmps)]),
    ...(opts.extra ?? []),
  ]
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].report
}
const decoupled = (report: ReturnType<typeof kickerLog>) => report.findings.find((f) => f.rule === 'mech/pair-decoupled')

/** The kicker spinning at 12 rot/s from 30 to 33 s and 45 to 48 s, still otherwise. */
const bursts = (t: number) => ((t >= 30 && t < 33) || (t >= 45 && t < 48) ? 12 : 0)
/** The leader 12.5 % fast from `from` for `seconds` (inside a burst), else with the follower. */
const leaderFast = (from: number, seconds: number) => (t: number) => (t >= from && t < from + seconds ? 1.125 * bursts(t) : bursts(t))

describe('mech/pair-decoupled', () => {
  it('fires on a stretch of 0.5 s or more apart, names the motor that ran free, and dates it at the stretch', () => {
    const f = decoupled(kickerLog(leaderFast(30.5, 1.2), bursts, (t) => (t >= 30.5 && t < 31.7 ? 1 : 5), (t) => (t >= 30.5 && t < 31.7 ? 4.5 : 5)))
    expect(f?.about).toBe('Kicker')
    expect(f?.severity).toBe('warning')
    expect(f?.time).toBeCloseTo(30.5, 1)
    expect(f?.evidence['longest stretch apart (s)']).toBeCloseTo(1.2, 1)
    expect(f?.evidence['ran free']).toBe('Kicker leader')
    expect(f?.evidence['Kicker leader: share of the pair\'s current in it (%)']).toBe(18)
    expect(f?.causes.filter((c) => c.likely).map((c) => c.id)).toEqual(['came-free', 'belt'])
    // The rest of the first burst (1.3 s) and the second (3 s) ran together: it cleared, and the finding says so.
    expect(f?.evidence['cleared later in the log']).toBe('yes')
    expect(f?.title).toMatch(/together again for 4.3 s after/)
  })
  it('says it did not clear when the pair never ran together again', () => {
    const apart = (t: number) => 1.125 * bursts(t)
    const f = decoupled(kickerLog((t) => (t >= 45 ? apart(t) : bursts(t)), bursts))
    expect(f?.evidence['cleared later in the log']).toBe('no')
    expect(f?.time).toBeCloseTo(45, 1)
  })
  it('stays quiet at 0.46 s apart', () => {
    expect(decoupled(kickerLog(leaderFast(30.5, 0.46), bursts))).toBeUndefined()
  })
  it('ends a stretch at any record within 4 %', () => {
    // 1.5 s apart, but every 0.3 s one record agrees.
    const broken = (t: number) => (t >= 30.5 && t < 32 && Math.round((t - 30.5) / 0.02) % 15 !== 14 ? 1.125 * bursts(t) : bursts(t))
    expect(decoupled(kickerLog(broken, bursts))).toBeUndefined()
  })
  it('ends a stretch at a gap of more than 0.1 s between records', () => {
    // 1 s apart, with no records from 30.93 to 31.07 s: two stretches of about 0.4 s.
    expect(decoupled(kickerLog(leaderFast(30.5, 1), bursts, undefined, undefined, { skip: (t) => t > 30.93 && t < 31.07 }))).toBeUndefined()
    expect(decoupled(kickerLog(leaderFast(30.5, 1), bursts))).toBeDefined()
  })
  it('does not compare records where a motor is at 5 rot/s or under', () => {
    // The follower sits at 4 rot/s while the leader runs at 12: not running, so never "apart".
    expect(decoupled(kickerLog(bursts, (t) => (bursts(t) ? 4 : 0)))).toBeUndefined()
  })
  it('says not checked when the pair never ran while enabled', () => {
    const report = kickerLog(() => 0, () => 0)
    expect(decoupled(report)).toBeUndefined()
    expect(report.skipped.find((s) => s.rule === 'mech/pair-decoupled')?.reason).toMatch(/Kicker never ran/)
  })
  it('sits under mech/motor-running-free when both see the same motor run free (one problem, one item)', () => {
    // 3 s apart, the leader on a fifth of the follower's current: both rules fire (running-free needs 2 s).
    const report = kickerLog(leaderFast(45, 2.9), bursts, (t) => (t >= 45 && t < 47.9 ? 1 : 5), (t) => (t >= 45 && t < 47.9 ? 5 : 5))
    const free = report.findings.find((f) => f.rule === 'mech/motor-running-free')
    expect(free?.about).toBe('Kicker')
    expect(decoupled(report)?.explainedBy).toMatchObject({ rule: 'mech/motor-running-free', why: 'the same motor ran free of the mechanism' })
    // A pit-run length (1.2 s): only the pair rule, standing on its own.
    const short = kickerLog(leaderFast(30.5, 1.2), bursts, (t) => (t >= 30.5 && t < 31.7 ? 1 : 5))
    expect(short.findings.some((f) => f.rule === 'mech/motor-running-free')).toBe(false)
    expect(decoupled(short)?.explainedBy).toBeUndefined()
  })
  it('says not checked, not OK, when the pair never ran 0.5 s unbroken', () => {
    const blips = (t: number) => (t >= 30 && t < 30.3 ? 12 : 0)
    const report = kickerLog(blips, blips)
    expect(decoupled(report)).toBeUndefined()
    expect(report.skipped.find((s) => s.rule === 'mech/pair-decoupled')?.reason).toMatch(/Kicker ran at most 0\.\d s at a time while enabled \(needs 0\.5 s to judge\)/)
  })
  it('does not read a follower frozen at its last speed (no record for over 0.1 s) as apart', () => {
    // The follower stops logging at 30.5 s while the leader runs 12.5 % fast: the held 12 rot/s is stale.
    expect(decoupled(kickerLog(leaderFast(30.5, 2), bursts, undefined, undefined, { skipFollower: (t) => t >= 30.5 && t < 33 }))).toBeUndefined()
  })
  it('does not compare while either motor reads disconnected', () => {
    const off: FixtureEntry = { name: '/Indexer/KickerFollowerConnected', type: 'boolean', records: [[20, true], [30.4, false], [33, true]] }
    expect(decoupled(kickerLog(leaderFast(30.5, 1.2), bursts, undefined, undefined, { extra: [off] }))).toBeUndefined()
  })
  it('still judges a pair with no current logged, and then says which ran free is unclear', () => {
    const f = decoupled(kickerLog(leaderFast(30.5, 1.2), bursts, undefined, undefined, { noCurrents: true }))
    expect(f?.evidence['ran free']).toMatch(/^unclear/)
  })
  it('judges only enabled time', () => {
    const enabledLate: FixtureEntry = { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [40, true], [60, false]] }
    const report = kickerLog(leaderFast(30.5, 1.2), bursts, undefined, undefined, { enabled: enabledLate })
    expect(decoupled(report)).toBeUndefined()
  })
})
