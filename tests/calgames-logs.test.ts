// The §5a expectations on the real CalGames logs (hindsight-research/design-detail.md). Skipped when the logs
// aren't in ~/Downloads; they are never copied into the repo.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import { listedAbove, reviewCard, reviewModel } from '../src/report/review-model.ts'
import { powerReport } from '../src/power/power-report.ts'
import { CALGAMES, fired, haveCalGames, readInput } from './helpers/load.ts'

if (!haveCalGames) console.warn('SKIPPED calgames-logs.test.ts: put the three CalGames .wpilog files and the matching .dslog in ~/Downloads to run it')

describe.skipIf(!haveCalGames)('CalGames 2026 logs', () => {
  const { analyses, problems } = haveCalGames
    ? analyzeFiles([CALGAMES.q13, CALGAMES.q21, CALGAMES.p0, CALGAMES.q13dslog].map(readInput))
    : { analyses: [], problems: [] }
  const byName = (s: string) => analyses.find((a) => a.match.fileName.includes(s))!
  const q13 = () => byName('q13'), q21 = () => byName('q21'), p0 = () => byName('p0')

  it('reads all three and attaches the DS log to Q13 only', () => {
    expect(problems).toEqual([])
    expect(analyses).toHaveLength(3)
    expect(q13().match.ds).toHaveLength(1)
    expect(q21().match.ds).toHaveLength(0)
    expect(p0().match.ds).toHaveLength(0)
  })

  it.each([
    ['q13', ['mech/zero-not-completed', 'comms/loss', 'comms/ds-log-truncated', 'auto/early-disable', 'collision/tilt']],
    ['q21', ['mech/follower-mismatch', 'mech/zero-not-completed', 'power/rest-voltage']],
    ['p0', ['power/brownout', 'can/device-dropout', 'build/dirty', 'power/battery-collapse']],
  ])('%s fires its §5a rules', (name, rules) => {
    const got = fired(byName(name).report)
    for (const r of rules) expect(got, r).toContain(r)
  })

  it.each(['q13', 'q21', 'p0'])('%s fires the rules every CalGames log fires', (name) => {
    const got = fired(byName(name).report)
    for (const r of ['power/margin', 'power/limit-not-applied', 'loop/overrun', 'vision/outliers', 'vision/stale', 'vision/time-sync', 'alerts/passthrough']) expect(got, r).toContain(r)
  })

  it('P0 does not fire mech/zero-not-completed (fixed in 8ba92cb)', () => {
    expect(fired(p0().report)).not.toContain('mech/zero-not-completed')
  })

  it('no log fires power/wiring-resistance (11 mΩ), and only P0 browns out or collapses', () => {
    for (const a of analyses) expect(fired(a.report)).not.toContain('power/wiring-resistance')
    expect(fired(q13().report)).not.toContain('power/brownout')
    expect(fired(q21().report)).not.toContain('power/brownout')
    expect(fired(q13().report)).not.toContain('power/battery-collapse')
    expect(fired(q21().report)).not.toContain('power/battery-collapse')
    expect(fired(q13().report)).not.toContain('power/rest-voltage')
    expect(fired(p0().report)).not.toContain('power/rest-voltage')
  })

  it('lists the missing accelerometer (Q13) and battery tracker (all) under meta/not-checked', () => {
    expect(q13().report.skipped.map((s) => s.rule)).toContain('collision/impact')
    for (const a of analyses) {
      const skipped = a.report.skipped.map((s) => s.rule)
      expect(skipped).toContain('battery/identity')
      expect(skipped).toContain('battery/gauge-capacity')
    }
    expect(q21().report.skipped.map((s) => s.rule)).toContain('comms/ds-log-truncated')
  })

  it('battery-collapse on Q21 is "partly checked" (compared up to 6.25 Ah), not "not checked"', () => {
    expect(q21().report.skipped.find((s) => s.rule === 'power/battery-collapse')?.reason).toMatch(/^partly checked; charge past 6.25 Ah/)
  })

  it('supply and stator problems of one group are separate known issues', () => {
    const keys = analyses.flatMap((a) => a.report.findings.filter((f) => f.rule === 'power/limit-not-applied').map((f) => f.key))
    expect(keys).toContain('power/limit-not-applied · Flywheel supply')
  })

  it('no rule crashes', () => {
    for (const a of analyses) expect(a.report.crashed).toEqual([])
  })

  it('reproduces the documented power numbers', () => {
    const r = (s: string) => powerReport(byName(s).match)!
    expect(r('q13').minVolts).toBeCloseTo(6.28, 2)
    expect(r('q21').minVolts).toBeCloseTo(6.15, 2)
    expect(r('p0').minVolts).toBeCloseTo(5.69, 2)
    // Battery + wiring resistance: 11.4 / 11.3 / 11.0 mΩ in the P0 analysis
    expect(r('q13').resistanceOhms! * 1000).toBeCloseTo(11.3, 0)
    expect(r('q21').resistanceOhms! * 1000).toBeCloseTo(11.4, 0)
    expect(r('p0').resistanceOhms! * 1000).toBeCloseTo(11.1, 0)
    // No-RC fit slope: 0.20 / 0.27 / 0.50 V/Ah in REVIEW.md
    expect(r('q13').fit!.kVoltsPerAh).toBeCloseTo(0.2, 1)
    expect(r('q21').fit!.kVoltsPerAh).toBeCloseTo(0.25, 1)
    expect(r('p0').fit!.kVoltsPerAh).toBeCloseTo(0.49, 1)
    const b = p0().report.findings.find((f) => f.rule === 'can/device-dropout')!
    expect(b.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('5.86, 6.20, 6.31, 5.85, 6.10, 6.02, 5.96')
  })

  it('links: Q13 and P0 read as one story each, Q21\'s camera alerts sit under the camera, red headlines 6 → 3, 5 → 2, 4 → 4', () => {
    const links = (name: string) => byName(name).report.findings.filter((f) => f.explainedBy).map((f) => `${f.rule}${f.about ? ` ${f.about}` : ''} ← ${f.explainedBy!.rule}`)
    expect(links('q13')).toEqual(['auto/early-disable ← collision/tilt', 'collision/tilt Pitch ← mech/zero-not-completed', 'comms/ds-log-truncated ← comms/loss'])
    expect(links('p0')).toEqual(['power/brownout ← power/battery-collapse', 'can/device-dropout Flywheel follower 16 ← power/brownout', 'alerts/passthrough Flywheel Follower Disconnected ← can/device-dropout', 'power/margin ← power/brownout'])
    expect(links('q21')).toEqual(['alerts/passthrough Back_Right Camera Disconnected! ← vision/stale', "alerts/passthrough PhotonCamera 'Back_Right' is disconnected. ← vision/stale"])
    // Headlines as the Match tab lists them: Q21's red alert stays one, since its camera finding is only amber.
    const redHeadlines = (name: string) => { const m = reviewModel(byName(name), new Map()); return [m.errors.length, m.headlines.filter((n) => n.finding.severity === 'error').length] }
    expect([redHeadlines('q13'), redHeadlines('p0'), redHeadlines('q21')]).toEqual([[6, 3], [5, 2], [4, 4]])
    const p0Model = reviewModel(p0(), new Map())
    expect(p0Model.bottomLine).toMatch(/^5 errors, .*Worst: Battery fell 2\.4 V below a healthy battery/)
    // The printed report's section counts: P0's margin warning is listed under the collapse, in the Errors section.
    expect([listedAbove(p0Model, 'warning'), listedAbove(p0Model, 'info')]).toEqual([1, 0])
    expect(reviewCard(p0Model).items[0].number).toMatch(/explains 3 errors, 1 warning$/)
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

describe.skipIf(!haveCalGames)('fleet reference curve', () => {
  it('equals the lower of Q13 and Q21 at each 0.5 Ah (guards against drift in the power model)', async () => {
    const { FLEET_REFERENCE } = await import('../src/power/fleet-reference.ts')
    const { buildPowerGrid, ocvCurve, resistanceFromSteps } = await import('../src/power/battery-model.ts')
    const { analyses } = analyzeFiles([CALGAMES.q13, CALGAMES.q21].map(readInput))
    const curves = analyses.map((a) => { const g = buildPowerGrid(a.match)!; return ocvCurve(g, resistanceFromSteps(g)!.ohms, 0.5) })
    for (const p of FLEET_REFERENCE) {
      // Q13's last bin (5.75 Ah) is post-match idle (rest recovery reads high); the lower value is what we keep.
      const lower = Math.min(...curves.map((c) => c.find((x) => x.ah === p.ah)?.volts ?? Infinity))
      expect(lower, `${p.ah} Ah`).toBeCloseTo(p.volts, 2)
    }
  })
})
