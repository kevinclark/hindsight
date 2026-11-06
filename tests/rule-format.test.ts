// The rule format promised in CONTRIBUTING.md: the example and the template work as written.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { runRules } from '../src/rules/index.ts'
import template from '../src/rules/_template/new-rule.ts'
import { writeWpilog } from './helpers/fixture-format.ts'
import { analyzeFixture, fired } from './helpers/load.ts'
import { RULES } from '../src/rules/index.ts'
import type { Rule } from '../src/rules/rule.ts'
import type { MatchView } from '../src/rules/view.ts'

const log = writeWpilog([
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.3], [25, 6.5], [26, 11]] },
])

describe('the rule format', () => {
  const a = analyzeFiles([{ name: 'test.wpilog', bytes: log }], offseason2026).analyses[0]
  it('the CONTRIBUTING example (power/rest-voltage) fires on a 12.3 V start', () => {
    expect(fired(a.report)).toContain('power/rest-voltage')
  })
  it('the template rule runs as copied', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/template' }])
    expect(r.crashed).toEqual([])
    expect(r.findings[0].title).toMatch(/Battery dipped under 7 V, first at 0:05 into the match \(auto; robot time 25\.0 s\)/)
  })
  it('a missing signal makes a rule "not checked", never a silent pass', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/missing', check: (m) => { m.signal('/Not/In/This/Log'); return undefined } }])
    expect(r.skipped).toEqual([{ rule: 'example/missing', reason: 'missing /Not/In/This/Log' }])
  })
})

describe('runner edge cases (review 2026-10-19)', () => {
  const run = (entries: Parameters<typeof writeWpilog>[0]) => analyzeFiles([{ name: 'edge.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].report
  const enabled = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  ] as Parameters<typeof writeWpilog>[0]
  it('median over a window with no record holds the last value before it (hold-last, never NaN)', () => {
    const r = run([...enabled, { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.3], [25, 12]] }])
    const f = r.findings.find((x) => x.rule === 'power/rest-voltage')
    expect(f?.measured?.[0].value).toBe(12.3)
  })
  it('rest voltage with no reading at or before the 2 s before auto is not checked', () => {
    const r = run([...enabled, { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[21, 12.3], [25, 12]] }])
    expect(r.findings.find((x) => x.rule === 'power/rest-voltage')).toBeUndefined()
    expect(r.skipped.find((s) => s.rule === 'power/rest-voltage')?.reason).toMatch(/2 s before auto/)
  })
  it('a log with no Alerts lists alerts/passthrough as not checked, not crashed', () => {
    const r = run(enabled)
    expect(r.crashed).toEqual([])
    expect(r.skipped.find((s) => s.rule === 'alerts/passthrough')?.reason).toMatch(/^missing /)
  })
  it('Alerts logged but none raised is a clean result', () => {
    const r = run([...enabled, { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[10, []]] }])
    expect(r.skipped.map((s) => s.rule)).not.toContain('alerts/passthrough')
  })
  it('brownouts are reported even without the brownout setting in the log', () => {
    const r = run([...enabled, { name: '/SystemStats/BrownedOut', type: 'boolean', records: [[10, false], [30, true], [30.2, false]] }, { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12], [30, 5.9]] }])
    const b = r.findings.find((f) => f.rule === 'power/brownout')!
    expect(b.evidence['brownout setting (V)']).toBe('not logged')
  })
  it('a never-enabled log gives no camera "stale NaN %"', () => {
    const r = run([
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false]] },
      { name: '/Apriltag VisionBack_Left/Stale', type: 'boolean', records: [[10, true]] },
      { name: '/Apriltag VisionBack_Left/Connected', type: 'boolean', records: [[10, true]] },
    ])
    expect(r.findings.filter((f) => f.rule === 'vision/stale')).toEqual([])
  })
})

describe('cause ids', () => {
  it('every rule has causes with unique ids, a meaning and a next step', () => {
    for (const r of RULES) {
      const ids = r.causes.map((c) => c.id)
      expect(new Set(ids).size, r.id).toBe(ids.length)
      expect(r.meaning.length, r.id).toBeGreaterThan(10)
      expect(r.nextStep.length, r.id).toBeGreaterThan(10)
    }
  })
  it('no rule names a cause it does not have (the runner reports that as a crash)', () => {
    const logs = ['auto-and-comms', 'follower-mismatch', 'brownout', 'flywheel-spinups', 'drive-plateau']
    for (const name of logs) for (const a of analyzeFixture(name).analyses) expect(a.report.crashed, name).toEqual([])
  })
  it('a typo in a likely id shows as a crashed rule', () => {
    const typo = { ...template, id: 'example/typo', check: () => ({ message: 'x', likely: ['no-such-cause'] }) }
    const match = analyzeFixture('auto-and-comms').analyses[0].match
    expect(runRules(match, [typo]).crashed[0].reason).toMatch(/no-such-cause/)
  })
})

describe('what the runner does with an answer', () => {
  const a = analyzeFiles([{ name: 'test.wpilog', bytes: log }], offseason2026).analyses[0]
  it('evidence left undefined is left out, and a plot defaults to 5 s either side of `at`', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/shape', check: () => ({
      message: 'shape', at: 25, evidence: { kept: 1, dropped: undefined }, plot: { signals: ['batteryVoltage'] },
    }) }])
    expect(r.findings[0].evidence).toEqual({ kept: 1 })
    expect(r.findings[0].plot).toMatchObject({ from: 20, to: 30, unit: '' })
  })
  it('a foresightOnly rule stays quiet on a match log', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/pit', foresightOnly: true, check: (m) => ({ message: 'pit', at: m.pitStretch.end }) }])
    expect(r).toEqual({ findings: [], skipped: [], crashed: [] })
  })
  describe('averagesOverTime', () => {
    // Battery voltage logged at 4 Hz while enabled: slow enough for the note.
    const volts: [number, number][] = []
    for (let t = 10; t < 35; t += 0.25) volts.push([t, 12.3])
    const slowLog = writeWpilog([
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: volts },
    ])
    const m = analyzeFiles([{ name: 'test.wpilog', bytes: slowLog }], offseason2026).analyses[0].match
    const reads: Rule = { ...template, id: 'example/reads-voltage', check: (v: MatchView) => { v.signal('/SystemStats/BatteryVoltage', 'battery voltage'); return { message: 'read it', at: 20 } } }
    const NOTE = 'logged slowly (short dips or spikes can be missed)'
    it('a rule that reads a slow signal carries the slow-logging note', () => {
      expect(runRules(m, [reads]).findings.find((f) => f.rule === 'example/reads-voltage')?.evidence[NOTE]).toMatch(/battery voltage is logged about 4 times a second/)
    })
    it('a rule that averages over time carries none, on a finding or as "partly checked"', () => {
      const avg = { ...reads, id: 'example/averages', averagesOverTime: true }
      expect(runRules(m, [avg]).findings.find((f) => f.rule === 'example/averages')?.evidence[NOTE]).toBeUndefined()
      const quietAvg: Rule = { ...avg, check: (v: MatchView) => { v.signal('/SystemStats/BatteryVoltage', 'battery voltage'); return undefined } }
      expect(runRules(m, [quietAvg]).skipped).toEqual([])
      expect(runRules(m, [{ ...quietAvg, averagesOverTime: undefined }]).skipped).toEqual([{ rule: 'example/averages', reason: expect.stringMatching(/^partly checked; battery voltage is logged about 4 times a second/) }])
    })
    it('a rule that averages over time keeps the note below the slowest rate measured (4 Hz)', () => {
      const slower: [number, number][] = []
      for (let t = 10; t < 35; t += 0.5) slower.push([t, 12.3])
      const log = writeWpilog([
        { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
        { name: '/SystemStats/BatteryVoltage', type: 'double', records: slower },
      ])
      const match = analyzeFiles([{ name: 'test.wpilog', bytes: log }], offseason2026).analyses[0].match
      const avg = { ...reads, id: 'example/averages', averagesOverTime: true }
      expect(runRules(match, [avg]).findings.find((f) => f.rule === 'example/averages')?.evidence[NOTE]).toMatch(/logged about 2 times a second/)
    })
    it('the two shipped rules that average over time are flagged, and no other', () => {
      expect(RULES.filter((r) => r.averagesOverTime).map((r) => r.id).sort()).toEqual(['power/main-breaker-margin', 'power/rest-voltage'])
    })
  })
  describe('needsEnabled', () => {
    const neverEnabled = writeWpilog([
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [35, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.3], [35, 12.2]] },
    ])
    const quiet = analyzeFiles([{ name: 'test.wpilog', bytes: neverEnabled }], offseason2026).analyses[0].match
    const judgesEnabled = { ...template, id: 'example/enabled-only', needsEnabled: true, check: () => undefined }
    it('a log that was never enabled gives a needsEnabled rule "not checked", not quiet', () => {
      const r = runRules(quiet, [judgesEnabled])
      expect(r.findings.map((f) => f.rule)).toEqual(['meta/not-checked'])
      expect(r.skipped).toEqual([{ rule: 'example/enabled-only', reason: 'the robot was never enabled' }])
    })
    it('the same log is unchanged for a rule without the flag', () => {
      const r = runRules(quiet, [{ ...judgesEnabled, id: 'example/whole-log', needsEnabled: undefined }])
      expect(r).toEqual({ findings: [], skipped: [], crashed: [] })
    })
    it('a Foresight view (a pit stretch to judge) is not skipped', () => {
      const pit = { ...quiet, foresight: { start: 10, end: 35, lastPassingSha: null } }
      const r = runRules(pit, [{ ...judgesEnabled, check: (m) => ({ message: 'pit', at: m.pitStretch ? 20 : 0 }) }])
      expect(r.skipped).toEqual([])
      expect(r.findings.map((f) => f.rule)).toEqual(['example/enabled-only'])
    })
  })
})
