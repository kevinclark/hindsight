// The §5a expectations on three of the team's real 2026 logs, A, B and C (tests/helpers/team-logs.ts). Skipped when
// they aren't listed; they are never copied into the repo.
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import { listedAbove, reviewCard, reviewModel } from '../src/report/review-model.ts'
import { powerReport } from '../src/power/power-report.ts'
import { LOGS, fired, haveLogs, readInput } from './helpers/load.ts'

if (!haveLogs) console.warn('SKIPPED team-logs.test.ts: list logs A, B, C and A\'s .dslog in ~/.hindsight/team-logs.json to run it')

describe.skipIf(!haveLogs)('the team\'s 2026 logs A, B and C', () => {
  const { analyses, problems } = haveLogs
    ? analyzeFiles([LOGS.a, LOGS.b, LOGS.c, LOGS.aDslog].map(readInput))
    : { analyses: [], problems: [] }
  const byName = (k: 'a' | 'b' | 'c') => analyses.find((a) => a.match.fileName === basename(LOGS[k]))!
  const logA = () => byName('a'), logB = () => byName('b'), logC = () => byName('c')

  it('reads all three and attaches the DS log to A only', () => {
    expect(problems).toEqual([])
    expect(analyses).toHaveLength(3)
    expect(logA().match.ds).toHaveLength(1)
    expect(logB().match.ds).toHaveLength(0)
    expect(logC().match.ds).toHaveLength(0)
  })

  it.each([
    ['a', ['mech/zero-not-completed', 'comms/loss', 'comms/ds-log-truncated', 'auto/early-disable', 'collision/tilt']],
    ['b', ['mech/follower-mismatch', 'mech/zero-not-completed', 'power/rest-voltage']],
    ['c', ['power/brownout', 'can/device-dropout', 'build/dirty', 'power/battery-collapse']],
  ] as const)('log %s fires its §5a rules', (name, rules) => {
    const got = fired(byName(name).report)
    for (const r of rules) expect(got, r).toContain(r)
  })

  it.each(['a', 'b', 'c'] as const)('log %s fires the rules every log of the event fires', (name) => {
    const got = fired(byName(name).report)
    for (const r of ['power/margin', 'power/limit-not-applied', 'loop/overrun', 'vision/outliers', 'vision/stale', 'vision/time-sync', 'alerts/passthrough']) expect(got, r).toContain(r)
  })

  it('C does not fire mech/zero-not-completed (fixed in 8ba92cb)', () => {
    expect(fired(logC().report)).not.toContain('mech/zero-not-completed')
  })

  it('no log fires power/wiring-resistance (11 mΩ), and only C browns out or collapses', () => {
    for (const a of analyses) expect(fired(a.report)).not.toContain('power/wiring-resistance')
    expect(fired(logA().report)).not.toContain('power/brownout')
    expect(fired(logB().report)).not.toContain('power/brownout')
    expect(fired(logA().report)).not.toContain('power/battery-collapse')
    expect(fired(logB().report)).not.toContain('power/battery-collapse')
    expect(fired(logA().report)).not.toContain('power/rest-voltage')
    expect(fired(logC().report)).not.toContain('power/rest-voltage')
  })

  it('lists the missing accelerometer (A) and battery tracker (all) under meta/not-checked', () => {
    expect(logA().report.skipped.map((s) => s.rule)).toContain('collision/impact')
    for (const a of analyses) {
      const skipped = a.report.skipped.map((s) => s.rule)
      expect(skipped).toContain('battery/identity')
      expect(skipped).toContain('battery/gauge-capacity')
    }
    expect(logB().report.skipped.map((s) => s.rule)).toContain('comms/ds-log-truncated')
  })

  it('battery-collapse on B is "partly checked" (compared up to 6.25 Ah), not "not checked"', () => {
    expect(logB().report.skipped.find((s) => s.rule === 'power/battery-collapse')?.reason).toMatch(/^partly checked; charge past 6.25 Ah/)
  })

  it('supply and stator problems of one group are separate known issues', () => {
    const keys = analyses.flatMap((a) => a.report.findings.filter((f) => f.rule === 'power/limit-not-applied').map((f) => f.key))
    expect(keys).toContain('power/limit-not-applied · Flywheel supply')
  })

  it('no rule crashes', () => {
    for (const a of analyses) expect(a.report.crashed).toEqual([])
  })

  it('reproduces the documented power numbers', () => {
    const r = (s: 'a' | 'b' | 'c') => powerReport(byName(s).match)!
    expect(r('a').minVolts).toBeCloseTo(6.28, 2)
    expect(r('b').minVolts).toBeCloseTo(6.15, 2)
    expect(r('c').minVolts).toBeCloseTo(5.69, 2)
    // Battery + wiring resistance: 11.4 / 11.3 / 11.0 mΩ in the team's analysis of these logs
    expect(r('a').resistanceOhms! * 1000).toBeCloseTo(11.3, 0)
    expect(r('b').resistanceOhms! * 1000).toBeCloseTo(11.4, 0)
    expect(r('c').resistanceOhms! * 1000).toBeCloseTo(11.1, 0)
    // No-RC fit slope: 0.20 / 0.27 / 0.50 V/Ah in REVIEW.md
    expect(r('a').fit!.kVoltsPerAh).toBeCloseTo(0.2, 1)
    expect(r('b').fit!.kVoltsPerAh).toBeCloseTo(0.25, 1)
    expect(r('c').fit!.kVoltsPerAh).toBeCloseTo(0.49, 1)
    const b = logC().report.findings.find((f) => f.rule === 'can/device-dropout')!
    expect(b.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('5.86, 6.20, 6.31, 5.85, 6.10, 6.02, 5.96')
  })

  it('links: A and C read as one story each, B\'s camera alerts sit under the camera, red headlines 6 → 3, 5 → 2, 4 → 4', () => {
    const links = (name: 'a' | 'b' | 'c') => byName(name).report.findings.filter((f) => f.explainedBy).map((f) => `${f.rule}${f.about ? ` ${f.about}` : ''} ← ${f.explainedBy!.rule}`)
    expect(links('a')).toEqual(['auto/early-disable ← collision/tilt', 'collision/tilt Pitch ← mech/zero-not-completed', 'comms/ds-log-truncated ← comms/loss'])
    expect(links('c')).toEqual(['power/brownout ← power/battery-collapse', 'can/device-dropout Flywheel follower 16 ← power/brownout', 'alerts/passthrough Flywheel Follower Disconnected ← can/device-dropout', 'power/margin ← power/brownout'])
    expect(links('b')).toEqual(['alerts/passthrough Back_Right Camera Disconnected! ← vision/stale', "alerts/passthrough PhotonCamera 'Back_Right' is disconnected. ← vision/stale"])
    // Headlines as the Match tab lists them: B's red alert stays one, since its camera finding is only amber.
    const redHeadlines = (name: 'a' | 'b' | 'c') => { const m = reviewModel(byName(name), new Map()); return [m.errors.length, m.headlines.filter((n) => n.finding.severity === 'error').length] }
    expect([redHeadlines('a'), redHeadlines('c'), redHeadlines('b')]).toEqual([[6, 3], [5, 2], [4, 4]])
    const cModel = reviewModel(logC(), new Map())
    expect(cModel.bottomLine).toMatch(/^5 errors, .*Worst: Battery fell 2\.4 V below a healthy battery/)
    // The printed report's section counts: C's margin warning is listed under the collapse, in the Errors section.
    expect([listedAbove(cModel, 'warning'), listedAbove(cModel, 'info')]).toEqual([1, 0])
    expect(reviewCard(cModel).items[0].number).toMatch(/explains 3 errors, 1 warning$/)
  })

  it('findings.json is under 2 MB and carries no radio status', () => {
    for (const a of analyses) {
      const text = JSON.stringify(buildFindingsJson(a.match, a.report))
      expect(text.length).toBeLessThan(2_000_000)
      expect(text).not.toMatch(/RadioStatus\/Status/)
      expect(JSON.parse(text).schema).toBe('hindsight.findings/2')
    }
  })
})

describe.skipIf(!haveLogs)('fleet reference curve', () => {
  it('equals the lower of A and B at each 0.5 Ah (guards against drift in the power model)', async () => {
    const { FLEET_REFERENCE } = await import('../src/power/fleet-reference.ts')
    const { buildPowerGrid, ocvCurve, resistanceFromSteps } = await import('../src/power/battery-model.ts')
    const { analyses } = analyzeFiles([LOGS.a, LOGS.b].map(readInput))
    const curves = analyses.map((a) => { const g = buildPowerGrid(a.match)!; return ocvCurve(g, resistanceFromSteps(g)!.ohms, 0.5) })
    for (const p of FLEET_REFERENCE) {
      // A's last bin (5.75 Ah) is post-match idle (rest recovery reads high); the lower value is what we keep.
      const lower = Math.min(...curves.map((c) => c.find((x) => x.ah === p.ah)?.volts ?? Infinity))
      expect(lower, `${p.ah} Ah`).toBeCloseTo(p.volts, 2)
    }
  })
})
