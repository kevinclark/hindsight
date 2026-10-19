// Phase 2: the Limits tab (Part A) against the reference script, and the limits wizard (Part B) on bench logs built
// from real CalGames spin-ups: the student path, "the setting didn't take", and "runs not comparable".
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { analyzeFiles } from '../src/analyze.ts'
import { limitsReport } from '../src/limits/limits-report.ts'
import { modalBin, settingTookEffect } from '../src/limits/sweep.ts'
import { checkStep, comparability, newSession, parseSession, serializeSession, sweepResult } from '../src/limits/session.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { Fixture } from './helpers/fixture-format.ts'
import { benchLog, type BenchOptions } from './helpers/bench-log.ts'
import { CALGAMES, haveCalGames, readInput } from './helpers/load.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { overThreshold, REFERENCE_KEYS } from '../scripts/limits-reference.ts'

const bench = (opts: BenchOptions) => analyzeFiles([{ name: `bench-${opts.limitA ?? 'none'}.wpilog`, bytes: benchLog(opts) }]).analyses[0].match

describe('"setting took" check', () => {
  it('passes the Q13 front-left drive at its real 40 A supply limit (mode 38–40 A)', () => {
    const f = JSON.parse(readFileSync('fixtures/q13-drive-plateau.json', 'utf8')) as Fixture
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

if (!haveCalGames) console.warn('SKIPPED limits Part A checks: CalGames logs not in ~/Downloads')

describe.skipIf(!haveCalGames)('Limits tab on the CalGames logs (Part A)', () => {
  const { analyses } = haveCalGames ? analyzeFiles([CALGAMES.q13, CALGAMES.q21, CALGAMES.p0].map(readInput)) : { analyses: [] }
  const brief = { q13: 6.06, q21: 6.8, p0: 6.72 } // flywheel leader supply > 45 A, from the phase 2 brief
  it.each(Object.entries(brief))('%s: flywheel leader over 45 A matches the brief and the reference script', (name, seconds) => {
    const a = analyses.find((x) => x.match.fileName.includes(name))!
    const fly = limitsReport(a.match).find((g) => g.group === 'Flywheel')!
    const leader = fly.supply.motors.find((m) => m.motor === 'Flywheel leader')!
    const ref = overThreshold(openWpilog(readInput(CALGAMES[name as 'q13']).bytes), REFERENCE_KEYS.flywheel[0], 45, REFERENCE_KEYS.flywheel[0].replace('Supply', 'Stator'))!
    expect(Math.abs(leader.secondsOver - seconds)).toBeLessThan(0.07)
    expect(Math.abs(ref.seconds - seconds)).toBeLessThan(0.07)
    expect(fly.supply.on).toBe(false)
    expect(fly.supply.note).toMatch(/removes Phoenix's default 70 A supply limit/)
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
