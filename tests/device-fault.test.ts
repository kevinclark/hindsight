// can/device-fault (experimental, ADR 14) and the tier it lives in: invented logs and readings only.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { attachHoot } from '../src/hoot/attach.ts'
import { rerunRules } from '../src/rules/run.ts'
import { RULES } from '../src/rules/index.ts'
import { NO_HOOT } from '../src/rules/can/device-fault.ts'
import { summarizeMatch } from '../src/session/summary.ts'
import type { HootDevice, HootReading } from '../src/hoot/types.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

// Robot log: enabled 20–35 s and 40–70 s (practice, no field).
const log = writeWpilog([
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false], [40, true], [70, false], [75, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6], [30, 11.8], [42, 9.1], [60, 12.0], [75, 12.5]] },
])
const open = () => analyzeFiles([{ name: 'test.wpilog', bytes: log }], offseason2026).analyses[0]

const device = (over: Partial<HootDevice> = {}): HootDevice => ({
  name: 'TalonFX-11', t: [28, 30, 32], volts: [12, 7.4, 11.9], amps: [5, 80, 6], temp: null, gaps: [], faults: [], resets: [], ...over,
})
// The .hoot's clock runs 12 s behind the robot log's: robot-log time = hoot time + 12.
const reading = (devices: HootDevice[], enable = [{ t: 0, on: false }, { t: 8, on: true }, { t: 23, on: false }, { t: 28, on: true }, { t: 58, on: false }]): HootReading => ({
  file: 'ABC_2026-03-14_20-14-20.hoot', bus: 'ABC', start: 0, end: 60, enable, mode: [], fms: [], totalAmps: { t: [], a: [] }, devices, cutShort: null, owlet: '26.3.0-C19',
})

describe('can/device-fault (experimental)', () => {
  it('with no .hoot it is not checked, in the tier\'s own list, and the robot-log report is untouched', () => {
    const a = open()
    expect(a.report.experimental).toEqual([])
    expect(a.report.experimentalSkipped).toEqual([{ rule: 'can/device-fault', reason: NO_HOOT }])
    expect(a.report.skipped.map((s) => s.rule)).not.toContain('can/device-fault')
    expect(RULES.map((r) => r.id)).not.toContain('can/device-fault')
  })

  it('names the device from the profile and places a fault on the robot log\'s clock (hoot 30 s + offset 12 s = 42 s) and reports it only in the tier', () => {
    const a = open()
    const before = a.report
    const report = attachHoot(a.match, before, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 30.26 }] })])])
    expect(report.findings).toBe(before.findings)
    expect(report.skipped).toBe(before.skipped)
    expect(report.experimentalSkipped).toEqual([])
    expect(report.experimental).toHaveLength(1)
    const f = report.experimental![0]
    expect(f.rule).toBe('can/device-fault')
    expect(f.time).toBeCloseTo(42, 6)
    expect(f.title).toBe('Indexer (TalonFX-11) raised bridge brownout while enabled')
    expect(f.about).toBe('Indexer (TalonFX-11): bridge brownout')
    expect(f.evidence['longest (s)']).toBe(0.26)
    expect(f.evidence['read from']).toMatch(/Phoenix \.hoot \(ABC_2026-03-14_20-14-20\.hoot\)/)
    expect(report.findings.some((x) => x.rule === 'can/device-fault')).toBe(false)
  })

  it('a fault while the robot log says disabled is not reported (hoot 24 s → 36 s)', () => {
    const a = open()
    const report = attachHoot(a.match, a.report, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 24, off: 24.2 }] })])])
    expect(report.experimental).toEqual([])
    expect(report.experimentalSkipped).toEqual([])
  })

  it('one finding per device and fault, counting each time', () => {
    const a = open()
    const faults = [{ name: 'Undervoltage', on: 30, off: 31 }, { name: 'Undervoltage', on: 40, off: 40.5 }, { name: 'BridgeBrownout', on: 41, off: null }]
    const report = attachHoot(a.match, a.report, [reading([device({ faults })])])
    expect(report.experimental!.map((f) => f.title)).toEqual(['Indexer (TalonFX-11) raised undervoltage 2 times while enabled', 'Indexer (TalonFX-11) raised bridge brownout while enabled'])
  })

  it('a .hoot with no CTRE device (a roboRIO bus file) is not "checked"', () => {
    const a = open()
    const report = attachHoot(a.match, a.report, [{ ...reading([]), file: 'rio_2026-03-14_20-14-20.hoot' }])
    expect(report.experimentalSkipped?.[0].reason).toMatch(/hold no CTRE device/)
  })

  it('a .hoot that can\'t be lined up is not checked, with why', () => {
    const a = open()
    const report = attachHoot(a.match, a.report, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 31 }] })], [{ t: 0, on: false }, { t: 8, on: true }])])
    expect(report.experimental).toEqual([])
    expect(report.experimentalSkipped?.[0].reason).toMatch(/not lined up with this log/)
  })

  it('attaching again replaces the tier; an empty list goes back to "no .hoot"', () => {
    const a = open()
    const once = attachHoot(a.match, a.report, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 31 }] })])])
    const twice = attachHoot(a.match, once, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 31 }] })])])
    expect(twice.experimental).toHaveLength(1)
    expect(twice.crashed).toEqual([])
    expect(attachHoot(a.match, twice, []).experimentalSkipped).toEqual([{ rule: 'can/device-fault', reason: NO_HOOT }])
  })

  it('rerunning other rules (a power-map change) keeps the tier', () => {
    const a = open()
    const attached = attachHoot(a.match, a.report, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 31 }] })])])
    const breakers = RULES.filter((r) => r.id === 'power/main-breaker-margin' || r.id === 'power/pdp-breaker-margin')
    const again = rerunRules(a.match, attached, breakers, RULES)
    expect(again.experimental).toBe(attached.experimental)
    expect(again.experimentalSkipped).toBe(attached.experimentalSkipped)
  })

  it('a session summary never reads the tier: the same with and without a .hoot attached', () => {
    const a = open()
    const plain = summarizeMatch(a.match, a.report, log.length)
    const attached = attachHoot(a.match, a.report, [reading([device({ faults: [{ name: 'BridgeBrownout', on: 30, off: 31 }] })])])
    const withTier = summarizeMatch(a.match, attached, log.length)
    expect(withTier).toEqual(plain)
    expect(withTier.rules['can/device-fault']).toBeUndefined()
  })
})
