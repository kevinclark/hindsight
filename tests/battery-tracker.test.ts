// Battery rules need FRC8033BatteryTracker keys, which the CalGames logs don't have. Synthetic logs here.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const base: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6], [30, 11]] },
]

function run(extra: FixtureEntry[]) {
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog([...base, ...extra]) }], offseason2026).analyses[0].report
}

describe('battery rules', () => {
  it('report "not checked" without the tracker keys', () => {
    const report = run([])
    const skipped = report.skipped.map((s) => s.rule)
    expect(skipped).toContain('battery/identity')
    expect(skipped).toContain('battery/gauge-capacity')
  })
  it('fire on an unknown battery and a low gauge capacity (gauge keys at the log root)', () => {
    const report = run([
      { name: '/RealOutputs/Battery/Id', type: 'string', records: [[10, '']] },
      { name: '/RealOutputs/Battery/IdSource', type: 'string', records: [[10, 'none']] },
      { name: '/BatteryGauge/Valid', type: 'boolean', records: [[10, true]] },
      { name: '/BatteryGauge/EffectiveCapacityAh', type: 'double', records: [[10, 10.5]] },
    ])
    expect(fired(report)).toContain('battery/identity')
    expect(fired(report)).toContain('battery/gauge-capacity')
  })
  it('stay quiet on a gauge-identified, healthy battery (gauge keys under /RealOutputs)', () => {
    const report = run([
      { name: '/RealOutputs/Battery/Id', type: 'string', records: [[10, 'B07']] },
      { name: '/RealOutputs/Battery/IdSource', type: 'string', records: [[10, 'gauge']] },
      { name: '/RealOutputs/BatteryGauge/Valid', type: 'boolean', records: [[10, true]] },
      { name: '/RealOutputs/BatteryGauge/EffectiveCapacityAh', type: 'double', records: [[10, 17.2]] },
    ])
    expect(fired(report)).not.toContain('battery/identity')
    expect(fired(report)).not.toContain('battery/gauge-capacity')
  })
  it('ignore capacity while the gauge is not valid', () => {
    const report = run([
      { name: '/BatteryGauge/Valid', type: 'boolean', records: [[10, false]] },
      { name: '/BatteryGauge/EffectiveCapacityAh', type: 'double', records: [[10, 0]] },
    ])
    expect(report.skipped.find((s) => s.rule === 'battery/gauge-capacity')?.reason).toMatch(/never gave a valid/)
  })
})
