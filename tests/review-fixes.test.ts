// Regression tests for the 2026-10-19 review findings (Fable review + code-review): each builds the case that broke.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { analyzeFiles } from '../src/analyze.ts'
import { writeDslog, writeWpilog, type Fixture, type FixtureEntry } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const q13 = JSON.parse(readFileSync('fixtures/q13-auto-and-comms.json', 'utf8')) as Fixture

describe('Driver Station logs are matched to the match window, not the whole robot log', () => {
  it('ignores a DS log that only overlaps the minutes after roboRIO boot', () => {
    // The real Q13 DS log starts 13.8 s into the robot log; one that ends 60 s in belongs to an earlier session.
    const stale = { ...q13.dslog!, name: 'stale.dslog', count: 2300, noRobotFrom: 2300 }
    const r = analyzeFiles([{ name: 'q13.wpilog', bytes: writeWpilog(q13.entries) }, { name: 'stale.dslog', bytes: writeDslog(stale) }])
    expect(r.analyses[0].match.ds).toHaveLength(0)
    expect(r.problems[0]).toMatch(/stale.dslog: doesn't overlap any loaded match/)
    expect(fired(r.analyses[0].report)).not.toContain('comms/ds-log-truncated')
  })
  it('keeps both DS logs when the DS app restarted, and flags the one that stopped mid-match', () => {
    const first = q13.dslog!
    const restartEpoch = first.startEpochSeconds + first.count * 0.02 + 4
    const second = { name: 'restart.dslog', startEpochSeconds: restartEpoch, count: 1500, robotFrom: 0, noRobotFrom: 1500 }
    const r = analyzeFiles([
      { name: 'q13.wpilog', bytes: writeWpilog(q13.entries) },
      { name: 'restart.dslog', bytes: writeDslog(second) },
      { name: first.name, bytes: writeDslog(first) },
    ])
    const m = r.analyses[0]
    expect(m.match.ds.map((d) => d.fileName)).toEqual([first.name, 'restart.dslog'])
    const truncated = m.report.findings.filter((f) => f.rule === 'comms/ds-log-truncated')
    expect(truncated).toHaveLength(1)
    expect(truncated[0].evidence['DS log file']).toBe(first.name)
  })
})

describe('the match window ignores enables before the match', () => {
  const entries: FixtureEntry[] = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [40, true], [60, false], [200, true], [220, false], [223, true], [363, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, false], [150, true], [221, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[10, false], [150, true]] },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[10, true]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.7], [199, 12.6], [300, 6.5], [301, 11]] },
    { name: '/SystemStats/BrownoutVoltage', type: 'double', records: [[10, 6]] },
  ]
  const a = analyzeFiles([{ name: 'queue.wpilog', bytes: writeWpilog(entries) }]).analyses[0]
  it('starts the match at the field auto, not the queue enable', () => {
    expect(a.match.matchStart).toBe(200)
    expect(a.match.teleopStart).toBe(223)
    expect(a.match.matchEnd).toBe(363)
  })
  it('says time left from the real teleop start', () => {
    const margin = a.report.findings.find((f) => f.rule === 'power/margin')!
    expect(margin.title).toMatch(/300\.0 s \(teleop, 63\.0 s left\)/)
    expect(margin.title).toMatch(/0\.50 V above/)
  })
})

describe('rules that check several devices report what they could not check', () => {
  it('lists power/limit-not-applied as not checked when no motor current is logged', () => {
    const r = analyzeFiles([{ name: 'q13.wpilog', bytes: writeWpilog(q13.entries) }]).analyses[0].report
    for (const rule of ['power/limit-not-applied', 'can/device-dropout']) {
      const reason = r.skipped.find((s) => s.rule === rule)?.reason ?? ''
      expect(reason, rule).toMatch(/missing /)
      expect(reason, rule).not.toMatch(/^partly/)
    }
  })
  it('says "partly checked" when only some keys are missing', () => {
    const r = analyzeFiles([{ name: 'p.wpilog', bytes: writeWpilog([
      ...q13.entries,
      { name: '/Drum/Hood/Connected', type: 'boolean', records: [[11.9, true]] },
    ]) }]).analyses[0].report
    expect(r.skipped.find((s) => s.rule === 'can/device-dropout')?.reason).toMatch(/^partly checked; .*missing /)
  })
})

describe('mech/zero-not-completed', () => {
  const base = q13.entries.filter((e) => !['/Drum/Hood/PositionRotations', '/RealOutputs/Console'].includes(e.name))
  const run = (hood: [number, number][], consoleLines: [number, string][]) => analyzeFiles([{ name: 'z.wpilog', bytes: writeWpilog([
    ...base,
    { name: '/Drum/Hood/PositionRotations', type: 'double', records: hood.map(([t, deg]) => [t, deg / 360]) },
    { name: '/RealOutputs/Console', type: 'string', records: consoleLines },
  ]) }]).analyses[0].report
  it('stays quiet when the hood travels down to its stop and then the zero completes', () => {
    const r = run([[260, 30], [270.3, 25], [270.6, 15], [270.9, 2], [271.2, 10], [272, 10]], [[271.1, 'Rezeroed hood']])
    expect(fired(r)).not.toContain('mech/zero-not-completed')
  })
  it('fires when the hood rises before the zero completes', () => {
    const r = run([[260, 2], [270.5, 2], [271, 9], [272, 9]], [[293.5, 'Rezeroed hood']])
    expect(fired(r)).toContain('mech/zero-not-completed')
  })
})
