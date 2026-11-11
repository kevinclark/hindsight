// Phase 2: the Limits tab (Part A) against the reference script, and the limits wizard (Part B) on bench logs built
// from real spin-ups in one of the team's 2026 matches: the student path, "the setting didn't take", and "runs not comparable".
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPair } from '../src/limits/pair.ts'
import { readFileSync } from 'node:fs'
import { analyzeFiles } from '../src/analyze.ts'
import { limitsReport, limitWords, overHeader } from '../src/limits/limits-report.ts'
import { PROFILES } from '../src/profiles/index.ts'
import type { CurrentLimits } from '../src/profiles/types.ts'
import { findSpinUps, modalBin, recommend, settingTookEffect } from '../src/limits/sweep.ts'
import { checkStep, comparability, newSession, parseSession, serializeSession, sweepResult } from '../src/limits/session.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { Fixture } from './helpers/fixture-format.ts'
import { benchLog, type BenchOptions } from './helpers/bench-log.ts'
import { LOGS, haveLogs, readInput } from './helpers/load.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { overThreshold, REFERENCE_KEYS } from '../scripts/limits-reference.ts'

const bench = (opts: BenchOptions) => analyzeFiles([{ name: `bench-${opts.limitA ?? 'none'}.wpilog`, bytes: benchLog(opts) }], offseason2026).analyses[0].match

describe('"setting took" check', () => {
  it('passes log A\'s front-left drive at its real 40 A supply limit (mode 38–40 A)', () => {
    const f = JSON.parse(readFileSync('fixtures/drive-plateau.json', 'utf8')) as Fixture
    const amps = (f.entries[0].records as [number, number][]).map(([, a]) => Math.abs(a)).filter((a) => a >= 30)
    const mode = modalBin(amps, 2)!
    expect(mode).toBeGreaterThanOrEqual(38)
    expect(mode).toBeLessThanOrEqual(40)
    const samples = (f.entries[0].records as [number, number][]).map(([t, a]) => [t, Math.abs(a)] as [number, number])
    const run = { plateau: [{ motor: 'Front Left drive', amps: mode }], peakSupply: [{ motor: 'Front Left drive', amps: Math.max(...amps) }], supply: [{ motor: 'Front Left drive', samples }] }
    const took = settingTookEffect([run as never], 40)
    expect(took.ok).toBe(true)
    expect(took.motors[0].verdict).toBe('held at the limit')
  })
})

describe('limits wizard on bench logs built from real spin-ups', () => {
  const sweep = [null, 60, 50, 40, 30]
  let session = newSession(offseason2026, 'Flywheel', sweep)

  it('student path: finds 3 runs per step, every limit took, runs comparable, recommends the knee', () => {
    sweep.forEach((limitA, i) => { session = checkStep(session, i, bench({ limitA }), 'B07') })
    for (const step of session.steps) {
      expect(step.runs, `${step.limitA}`).toHaveLength(3)
      if (step.limitA !== null) expect(step.took?.ok, `${step.limitA}: ${step.took?.problems}`).toBe(true)
    }
    expect(comparability(session).ok).toBe(true)
    const result = sweepResult(session, offseason2026, [])
    const times = result.points.map((p) => p.timeToSetpoint)
    for (let i = 1; i < times.length; i++) expect(times[i], `step ${i}`).toBeGreaterThanOrEqual(times[i - 1] - 0.02) // lower limit, never faster
    expect(result.recommended).not.toBeNull()
    expect(result.recommended!.limitA).toBeGreaterThanOrEqual(30)
    expect(result.codeChange).toMatch(/^DrumSubsystem\.java:309-310: SupplyCurrentLimit = \d+ and SupplyCurrentLimitEnable = true/)
  })

  it('the session survives a save and reload', () => {
    expect(parseSession(serializeSession(session))).toEqual(session)
  })

  it('"setting didn\'t take": a follower still drawing full current is named', () => {
    const s = checkStep(newSession(offseason2026, 'Flywheel'), 3, bench({ limitA: 40, notSavedOn: 'Follower 1' }), 'B07')
    expect(s.steps[3].took?.ok).toBe(false)
    expect(s.steps[3].took?.problems.join(' ')).toMatch(/^Flywheel follower 17 still at \d+ A .* not held at 40 A: was the limit saved on every motor\?$/)
    expect(s.steps[3].took?.motors.filter((m) => m.verdict === 'did not take').map((m) => m.motor)).toEqual(['Flywheel follower 17'])
    // ...and that step is left out of the recommendation until it is re-run.
    const withBaseline = checkStep(s, 0, bench({ limitA: null }), 'B07')
    const r = sweepResult(withBaseline, offseason2026, [])
    expect(r.leftOut).toEqual([40])
    expect(r.points.map((p) => p.limitA)).toEqual([null])
  })

  it('"cannot tell" at 60 A: an unsaved follower only overshoots briefly, so the run can\'t show it either way', () => {
    const s = checkStep(newSession(offseason2026, 'Flywheel'), 1, bench({ limitA: 60, notSavedOn: 'Follower 1' }), 'B07')
    const f17 = s.steps[1].took!.motors.find((m) => m.motor === 'Flywheel follower 17')!
    expect(f17.verdict).toBe('cannot tell')
    expect(s.steps[1].took!.problems.join(' ')).toMatch(/Can't tell from these runs whether the limit took on Flywheel follower 17/)
    // ...and an unconfirmed step stays out of the recommendation.
    expect(sweepResult(checkStep(s, 0, bench({ limitA: null }), 'B07'), offseason2026, []).leftOut).toEqual([60])
  })

  it('a battery swapped between runs of one log is caught (the ID at each run, not the last one)', () => {
    const s = checkStep(newSession(offseason2026, 'Flywheel'), 0, bench({ limitA: null, batteryIds: ['B07', 'B07', 'B03'] }), '')
    expect(s.steps[0].runs.map((r) => r.batteryId)).toEqual(['B07', 'B07', 'B03'])
    expect(comparability(s).problems.join(' ')).toMatch(/different batteries: B07, B03/)
  })

  it('the recommendation walks down from the highest limit and stops at the first too-slow one', () => {
    const p = (limitA: number | null, t: number) => ({ limitA, timeToSetpoint: t, peakGroupA: 0, dipVolts: 0 })
    expect(recommend([p(null, 1), p(60, 1.05), p(50, 1.3), p(40, 1.1)], 0.2)?.limitA).toBe(60) // 40 passes only by noise
  })

  it('"runs not comparable": a different battery, or a start more than 0.3 V lower', () => {
    let s = newSession(offseason2026, 'Flywheel')
    s = checkStep(s, 0, bench({ limitA: null }), 'B07')
    s = checkStep(s, 1, bench({ limitA: 60, voltsOffset: [0, 0, -0.4] }), 'B03')
    const c = comparability(s)
    expect(c.ok).toBe(false)
    expect(c.problems.join(' ')).toMatch(/different batteries: B07, B03/)
    expect(c.problems.join(' ')).toMatch(/more than 0\.3 V apart/)
  })
})

if (!haveLogs) console.warn('SKIPPED limits Part A checks: the team\'s logs A, B and C are not listed (tests/helpers/team-logs.ts)')

describe.skipIf(!haveLogs)('Limits tab on the team\'s 2026 logs (Part A)', () => {
  const { analyses } = haveLogs ? analyzeFiles([LOGS.a, LOGS.b, LOGS.c].map(readInput)) : { analyses: [] }
  const brief = { a: 6.06, b: 6.8, c: 6.72 } // flywheel leader supply > 45 A, from the phase 2 brief
  it.each(Object.entries(brief))('log %s: flywheel leader over 45 A matches the brief and the reference script', (name, seconds) => {
    const a = analyses.find((x) => x.match.fileName === basename(LOGS[name as 'a']))!
    const fly = limitsReport(a.match).find((g) => g.group === 'Flywheel')!
    const leader = fly.supply.motors.find((m) => m.motor === 'Flywheel leader')!
    const ref = overThreshold(openWpilog(readInput(LOGS[name as 'a']).bytes), REFERENCE_KEYS.flywheel[0], 45, REFERENCE_KEYS.flywheel[0].replace('Supply', 'Stator'))!
    expect(Math.abs(leader.secondsOver - seconds)).toBeLessThan(0.07)
    expect(Math.abs(ref.seconds - seconds)).toBeLessThan(0.07)
    expect(fly.supply.on).toBe(false)
    expect(fly.supply.note).toMatch(/removes Phoenix's default 70 A supply limit/)
  })
  it('on the real (unlimited) spin-ups, a 60 A check says "cannot tell", never "took"', () => {
    for (const a of analyses) {
      const runs = findSpinUps(a.match, offseason2026.motorGroups.find((g) => g.name === 'Flywheel')!)
      const took = settingTookEffect(runs, 60)
      expect(took.motors.some((m) => m.verdict === 'cannot tell' || m.verdict === 'did not take'), a.match.fileName).toBe(true)
      expect(took.problems.length).toBeGreaterThan(0)
    }
  })

  it('flywheel followers spend 5.9–10.6 s over 45 A; drive bursts over it last ≤ 0.21 s', () => {
    for (const a of analyses) {
      const groups = limitsReport(a.match)
      for (const f of groups.find((g) => g.group === 'Flywheel')!.supply.motors.slice(1)) {
        expect(f.secondsOver).toBeGreaterThanOrEqual(5.85)
        expect(f.secondsOver).toBeLessThanOrEqual(10.65)
      }
      for (const d of groups.find((g) => g.group === 'Drive')!.supply.motors) expect(d.longestOver).toBeLessThanOrEqual(0.215)
    }
  })
})

describe('burst / sustained pair', () => {
  const flywheel = offseason2026.motorGroups.find((g) => g.name === 'Flywheel')!
  const drive = offseason2026.motorGroups.find((g) => g.name === 'Drive')!
  it('uses Phoenix\'s 40 A after 1 s as the sustained cap until the student chooses one', () => {
    const p = checkPair(offseason2026, flywheel, 60, null, null, ['Drive'])
    expect(p).toMatchObject({ lowerA: 40, lowerSeconds: 1, lowerIsDefault: true })
  })
  it('adds up the sustained caps of the groups that run together against the 120 A main', () => {
    // Drive 4 × 40 A (its supply limit) + flywheel 4 × 25 A = 260 A: over the main breaker.
    const p = checkPair(offseason2026, flywheel, 60, 25, 1, ['Drive'])
    expect(p.sustained.totalA).toBe(260)
    expect(p.sustained.ok).toBe(false)
  })
  it('reads a lower time of 0 as no lower limit (Phoenix 6 ignores the lower limit then): the supply limit is the sustained cap', () => {
    // A code-set `SupplyCurrentLimit = 60; SupplyCurrentLowerTime = 0;` on the drive: 4 × 60 A sustained, not 4 × 40 A.
    const profile = { ...offseason2026, motorGroups: offseason2026.motorGroups.map((g) => (g === drive ? { ...g, limits: { supplyA: 60, supplyEnabled: true, supplyLowerSeconds: 0, where: 'Drive.java:10' } } : g)) }
    const p = checkPair(profile, flywheel, 60, 25, 1, ['Drive'])
    expect(p.sustained.rows.find((r) => r.group === 'Drive')!.perMotorA).toBe(60)
    // The Limits tab says so, instead of "after 0 s at the cap it drops to 40 A".
    // A match with no current logged: only the configured limits are read.
    const unlogged = { ...profile, motorGroups: profile.motorGroups.map((g) => ({ ...g, motors: g.motors.map(({ name }) => ({ name })) })) }
    const match = { profile: unlogged, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0]
    const note = limitsReport(match).find((g) => g.group === 'Drive')!.supply.note
    expect(note).toBe('capped at 60 A; no lower limit (the code sets its time to 0)')
  })
  it('a group whose limits aren\'t known is "not known", never Phoenix\'s defaults', () => {
    const unknown = { where: 'not known: drop a robot snapshot, or set them in the profile' }
    const profile = { ...offseason2026, motorGroups: offseason2026.motorGroups.map((g) => (g === drive ? { ...g, limits: unknown } : g)) }
    // The pair leaves the drive out of the sum and names it, instead of counting 4 × 40 A it doesn't know.
    const p = checkPair(profile, flywheel, 60, 25, 1, ['Drive'])
    expect(p.sustained.rows.find((r) => r.group === 'Drive')!.perMotorA).toBeNaN()
    expect([p.sustained.totalA, p.notKnown]).toEqual([100, ['Drive']])
    // The Limits tab says so, instead of "not set: Phoenix's default 70 A applies".
    const unlogged = { ...profile, motorGroups: profile.motorGroups.map((g) => ({ ...g, motors: g.motors.map(({ name }) => ({ name })) })) }
    const report = limitsReport({ profile: unlogged, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0]).find((g) => g.group === 'Drive')!
    // A builder profile's "not known: …" isn't said twice; another profile's reason gets "not known:" in front.
    expect([report.supply.note, report.stator.note, report.verdict, report.capPerMotorA]).toEqual([unknown.where, unknown.where, 'limits not known', NaN])
    const notRead = { ...unlogged, motorGroups: unlogged.motorGroups.map((g) => (g.name === 'Drive' ? { ...g, limits: { where: 'not read from the code' } } : g)) }
    expect(limitsReport({ profile: notRead, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0]).find((g) => g.group === 'Drive')!.supply.note).toBe('not known: not read from the code')
    // The pinned push isn't worked out from a default stator limit nobody read.
    expect(p.pinnedDrive).toBeNull()
    // The wizard's own group: no "today's 70 A" to compare a burst cap with.
    const own = checkPair(profile, profile.motorGroups.find((g) => g.name === 'Drive')!, 80, 30, 1)
    expect([own.todaySupplyA, own.todayKnown, own.raisesBurst]).toEqual([null, false, false])
  })
  it('warns not to raise a burst cap above today\'s', () => {
    expect(checkPair(offseason2026, drive, 70, 30, 1).raisesBurst).toBe(true)
    expect(checkPair(offseason2026, drive, 40, 30, 1).raisesBurst).toBe(false)
  })
})

// A profile drafted from code leaves an Enable flag out when the code has no Enable line (src/builder/code-draft.ts):
// HighlanderRobotics/Rebuilt 2cd2843 sets SupplyCurrentLimit with no SupplyCurrentLimitEnable for five groups
// (TurretSubsystem.java:531 and 557, ShooterSubsystem.java:250 and 276, ClimberIO.java:89). Phoenix 6 defaults the flag
// to true, but a hand-written profile may simply not say, so the flag is not known: not on, not off (the same reading
// as limit-not-applied, LN-09).
describe('an Enable flag the profile leaves out', () => {
  const drive = offseason2026.motorGroups.find((g) => g.name === 'Drive')!
  const flywheel = offseason2026.motorGroups.find((g) => g.name === 'Flywheel')!
  const withLimits = (group: string, limits: CurrentLimits) => ({ ...offseason2026, motorGroups: offseason2026.motorGroups.map((g) => (g.name === group ? { ...g, limits } : g)) })
  const limitsReportOf = (profile: typeof offseason2026) => {
    const unlogged = { ...profile, motorGroups: profile.motorGroups.map((g) => ({ ...g, motors: g.motors.map(({ name }) => ({ name })) })) }
    return limitsReport({ profile: unlogged, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0])
  }
  const report = (profile: typeof offseason2026, group: string) => {
    const unlogged = { ...profile, motorGroups: profile.motorGroups.map((g) => ({ ...g, motors: g.motors.map(({ name }) => ({ name })) })) }
    return limitsReport({ profile: unlogged, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0]).find((g) => g.group === group)!
  }

  it('the Limits tab reads a supply limit with no flag as neither on nor off, and says what decides it', () => {
    const r = report(withLimits('Hood', { supplyA: 60, statorA: 80, statorEnabled: true, where: 'TurretSubsystem.java:555-557' }), 'Hood')
    expect(r.supply.on).toBeNull()
    expect(r.supply.note).toBe('60 A if the code switches it on: the profile doesn\'t say. Phoenix switches it on unless the code sets SupplyCurrentLimitEnable = false')
    expect(r.stator.on).toBe(true)
  })

  it('the Limits tab\'s cap is not known when the flag decides it, and known when it doesn\'t', () => {
    // On: 60 A; off: the 80 A stator limit caps it. The flag decides, so the cap is not known.
    expect(report(withLimits('Hood', { supplyA: 60, statorA: 80, statorEnabled: true, where: 'x' }), 'Hood').capPerMotorA).toBeNaN()
    // Stator switched off: on gives 40 A, off gives nothing. Not known either.
    expect(report(withLimits('Hood', { supplyA: 40, statorA: 120, statorEnabled: false, where: 'x' }), 'Hood').capPerMotorA).toBeNaN()
    // A 30 A stator limit caps the motor under a 60 A supply limit whichever way its flag is set.
    expect(report(withLimits('Hood', { supplyA: 60, statorA: 30, statorEnabled: true, where: 'x' }), 'Hood').capPerMotorA).toBe(30)
  })

  it('the Limits tab reads a stator limit with no flag the same way', () => {
    const r = report(withLimits('Hood', { supplyA: 40, supplyEnabled: true, statorA: 80, where: 'x' }), 'Hood')
    expect(r.stator.on).toBeNull()
    expect(r.stator.note).toBe('80 A if the code switches it on: the profile doesn\'t say. Phoenix switches it on unless the code sets StatorCurrentLimitEnable = false')
    expect(r.capPerMotorA).toBe(40)
  })

  it('the Limits tab measures the share at the limit against a flagless supply number, before a stator limit known to be on', () => {
    // Bench spin-ups of the Flywheel group with logged currents: the share is the supply number's, as when it is on.
    const flagless = withLimits('Flywheel', { supplyA: 40, statorA: 80, statorEnabled: true, where: 'x' })
    const on = withLimits('Flywheel', { supplyA: 40, supplyEnabled: true, statorA: 80, statorEnabled: true, where: 'x' })
    const share = (profile: typeof offseason2026) => {
      const match = analyzeFiles([{ name: 'bench-none.wpilog', bytes: benchLog({ limitA: null }) }], profile).analyses[0].match
      return limitsReport(match).find((g) => g.group === 'Flywheel')!
    }
    const [a, b] = [share(flagless), share(on)]
    expect(a.supply.motors.length).toBeGreaterThan(0)
    expect(a.shareAtLimit).toBeGreaterThan(0)
    expect(a.shareAtLimit).toBe(b.shareAtLimit)
    expect(a.verdict).toBe(b.verdict)
  })

  it('every built-in profile: a group whose limits aren\'t known says nothing about on or off; an unset limit with no flag is Phoenix\'s default, on', () => {
    for (const profile of PROFILES) {
      for (const g of limitsReportOf(profile)) {
        const l = profile.motorGroups.find((x) => x.name === g.group)!.limits
        if (g.verdict === 'limits not known') expect([g.supply.on, g.stator.on], `${profile.name} / ${g.group}`).toEqual([null, null])
        if (l.supplyA === undefined && l.supplyEnabled === undefined && g.verdict !== 'limits not known') expect(g.supply.on).toBe(true)
        if (l.statorA === undefined && l.statorEnabled === undefined && g.verdict !== 'limits not known') expect(g.stator.on).toBe(true)
      }
    }
  })

  it('a limit switched off with no number reads as off, not as Phoenix\'s default (2025 offseason Climber pivot)', () => {
    const r = report(withLimits('Hood', { supplyEnabled: false, statorA: 120, statorEnabled: false, where: 'Robot.java:270-274' }), 'Hood')
    expect(r.supply.on).toBe(false)
    expect(r.supply.note).toBe('switched off in code: this removes Phoenix\'s default 70 A supply limit')
    expect(r.capPerMotorA).toBe(Infinity)
  })

  it('the wizard\'s words: on, switched off, not in the profile, or Phoenix\'s default', () => {
    expect(['on', 'off', 'missing'].map((x) => limitWords({ supplyA: 40, ...(x === 'missing' ? {} : { supplyEnabled: x === 'on' }), where: 'x' }, 'supply')))
      .toEqual(['40 A, on', '40 A, switched off', '40 A, on or off: the profile doesn\'t say'])
    expect(limitWords({ statorA: 80, statorEnabled: true, where: 'x' }, 'supply')).toBe('not set: Phoenix\'s default 70 A')
    expect(limitWords({ supplyEnabled: false, statorA: 120, statorEnabled: false, where: 'x' }, 'supply')).toBe('switched off')
  })

  it('the pair leaves a group with no supply flag out of the sustained sum and names it', () => {
    const profile = withLimits('Drive', { supplyA: 40, statorA: 120, statorEnabled: true, where: 'x' })
    const p = checkPair(profile, flywheel, 60, 25, 1, ['Drive'])
    expect(p.sustained.rows.find((r) => r.group === 'Drive')!.perMotorA).toBeNaN()
    expect([p.sustained.totalA, p.notKnown, p.unlimited]).toEqual([100, ['Drive'], []])
  })

  it('the pair has no "today" to compare a burst cap with when its own supply flag is missing', () => {
    const profile = withLimits('Drive', { supplyA: 40, statorA: 120, statorEnabled: true, where: 'x' })
    const own = checkPair(profile, profile.motorGroups.find((g) => g.name === 'Drive')!, 80, 30, 1)
    expect([own.todaySupplyA, own.todayKnown, own.raisesBurst]).toEqual([null, false, false])
    // It still warns: 80 A may be a raise over today's 40 A.
    expect(own.todaySupplyOnNotKnown).toBe(40)
    expect(checkPair(profile, profile.motorGroups.find((g) => g.name === 'Drive')!, 30, 30, 1).todaySupplyOnNotKnown).toBeNull()
    expect(checkPair(offseason2026, drive, 70, 30, 1).todaySupplyOnNotKnown).toBeNull()
  })

  it('the pinned push isn\'t worked out from a stator limit whose flag is missing, and says so', () => {
    const profile = withLimits('Drive', { supplyA: 40, supplyEnabled: true, statorA: 120, where: 'x' })
    const p = checkPair(profile, flywheel, 60, 25, 1, ['Drive'])
    expect([p.pinnedDrive, p.driveNotKnown]).toEqual([null, 'Drive'])
    // With the flag set, it is worked out as before.
    expect(checkPair(offseason2026, flywheel, 60, 25, 1, ['Drive']).pinnedDrive).not.toBeNull()
    expect(drive.limits.statorEnabled).toBe(true)
  })
})

describe('Limits tab wording (presentation)', () => {
  const unlogged = (limits: CurrentLimits) => {
    const profile = { ...offseason2026, motorGroups: offseason2026.motorGroups.map((g) => ({ ...g, limits, motors: g.motors.map(({ name }) => ({ name })) })) }
    return limitsReport({ profile, enabled: [], logEnd: 0 } as unknown as Parameters<typeof limitsReport>[0])[0]
  }
  it('does not say the cap "drops" up to a lower limit that is above the supply limit', () => {
    const r = unlogged({ supplyA: 20, supplyEnabled: true, statorEnabled: true, where: 'X.java:1' })
    expect(r.supply.note).toBe("capped at 20 A (Phoenix's default lower limit, 40 A, is above it)")
  })
  it('still says it drops when the lower limit is below the supply limit', () => {
    const r = unlogged({ supplyA: 60, supplyEnabled: true, statorEnabled: true, where: 'X.java:1' })
    expect(r.supply.note).toBe("capped at 60 A; after 1 s at the cap it drops to 40 A (Phoenix defaults: the code doesn't set these)")
  })
  it('names a lower limit the code sets that is above the supply limit without the Phoenix default wording', () => {
    const r = unlogged({ supplyA: 20, supplyEnabled: true, statorEnabled: true, supplyLowerA: 30, supplyLowerSeconds: 1, where: 'X.java:1' })
    expect(r.supply.note).toBe('capped at 20 A (the lower limit the code sets, 30 A, is above it)')
  })
  it('says a lower limit equal to the supply limit is the same, never "above it" or a drop', () => {
    const r = unlogged({ supplyA: 40, supplyEnabled: true, statorEnabled: true, where: 'X.java:1' })
    expect(r.supply.note).toBe("capped at 40 A (Phoenix's default lower limit is the same, 40 A)")
  })
  it('heads the "over" column with the limit it was measured against, never arithmetic on a dash', () => {
    expect(overHeader({ kind: 'stator', limitA: 120, on: true }, true)).toEqual({ text: 'over 120+5 A', measured: true })
    expect(overHeader({ kind: 'stator', limitA: null, on: true }, true)).toEqual({ text: "over 120+5 A (Phoenix's default)", measured: true })
    expect(overHeader({ kind: 'supply', limitA: null, on: true }, true)).toEqual({ text: "over 70+5 A (Phoenix's default)", measured: true })
    expect(overHeader({ kind: 'stator', limitA: null, on: false }, true)).toEqual({ text: 'over: no limit set', measured: false })
    expect(overHeader({ kind: 'stator', limitA: null, on: true }, false)).toEqual({ text: 'over: limit not known', measured: false })
  })
})
