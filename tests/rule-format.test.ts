// The rule format promised in CONTRIBUTING.md: the example and the template work as written.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { runRules } from '../src/rules/index.ts'
import template from '../src/rules/_template/new-rule.ts'
import { writeWpilog } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const log = writeWpilog([
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.3], [25, 6.5], [26, 11]] },
])

describe('the rule format', () => {
  const a = analyzeFiles([{ name: 'test.wpilog', bytes: log }]).analyses[0]
  it('the CONTRIBUTING example (power/rest-voltage) fires on a 12.3 V start', () => {
    expect(fired(a.report)).toContain('power/rest-voltage')
  })
  it('the template rule runs as copied', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/template' }])
    expect(r.crashed).toEqual([])
    expect(r.findings[0].title).toMatch(/Battery dipped under 7 V, first at 25\.0 s/)
  })
  it('a missing signal makes a rule "not checked", never a silent pass', () => {
    const r = runRules(a.match, [{ ...template, id: 'example/missing', check: (m) => { m.signal('/Not/In/This/Log'); return undefined } }])
    expect(r.skipped).toEqual([{ rule: 'example/missing', reason: 'missing /Not/In/This/Log' }])
  })
})

describe('runner edge cases (review 2026-10-19)', () => {
  const run = (entries: Parameters<typeof writeWpilog>[0]) => analyzeFiles([{ name: 'edge.wpilog', bytes: writeWpilog(entries) }]).analyses[0].report
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
