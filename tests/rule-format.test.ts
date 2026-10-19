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
