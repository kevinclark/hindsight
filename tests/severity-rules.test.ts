// Severity that depends on what was measured: comms/loss (a blip is not an outage), vision/time-sync (boot-only),
// power/limit-not-applied (limit switched off in code). Made-up logs, both sides of each boundary.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const run = (entries: FixtureEntry[]) =>
  analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].report.findings
const only = (entries: FixtureEntry[], rule: string) => run(entries).filter((f) => f.rule === rule)

/** A match: enabled from 10 s to 410 s, with the given extra signals. */
const match = (extra: FixtureEntry[]): FixtureEntry[] => [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [410, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
  { name: '/DriverStation/DSAttached', type: 'boolean', records: [[0, true]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [420, 12.3]] },
  ...extra,
]

describe('comms/loss severity', () => {
  /** Comms lost at each time in `at`, the outputs back on `dead[i]` seconds later (null: never logged back on). */
  const losses = (at: number[], dead: number[] | null): FixtureEntry[] => [
    { name: '/SystemStats/CommsDisableCount', type: 'int64', records: [[0, 0], ...at.map((t, i) => [t, i + 1] as [number, number])] },
    ...(dead === null ? [] : [{
      name: '/SystemStats/SystemActive', type: 'boolean',
      records: [[0, true], ...at.flatMap((t, i) => [[t, false], [t + dead[i], true]] as [number, boolean][])] as [number, boolean][],
    }]),
  ]
  const lossFinding = (at: number[], dead: number[] | null) => only(match(losses(at, dead)), 'comms/loss')[0]

  it('one blip of 0.1 s is info, and the message says it was brief', () => {
    const f = lossFinding([100], [0.1])
    expect(f.severity).toBe('info')
    expect(f.title).toMatch(/^Lost comms for 0\.1 s \(a blip\)/)
  })
  it('a loss of 0.49 s is a blip; one of 0.5 s is an error', () => {
    expect(lossFinding([100], [0.49]).severity).toBe('info')
    expect(lossFinding([100], [0.5]).severity).toBe('error')
  })
  it('two blips are info, three are a warning', () => {
    expect(lossFinding([100, 200], [0.1, 0.2]).severity).toBe('info')
    const three = lossFinding([100, 200, 300], [0.1, 0.2, 0.3])
    expect(three.severity).toBe('warning')
    expect(three.title).toMatch(/^Lost comms 3 times \(all blips, the longest 0\.3 s\)/)
  })
  it('a single long loss among blips keeps the error', () => {
    expect(lossFinding([100, 200, 300], [0.1, 0.2, 7.4]).severity).toBe('error')
  })
  it('an unknown duration (systemActive not logged) keeps the error and does not say blip', () => {
    const f = lossFinding([100], null)
    expect(f.severity).toBe('error')
    expect(f.title).not.toMatch(/blip/)
  })
  it('keeps the battery evidence', () => {
    const f = lossFinding([100], [0.1])
    expect(Object.keys(f.evidence ?? {}).join('|')).toMatch(/lowest battery voltage in the 0\.5 s before each/)
  })
})

describe('vision/time-sync severity', () => {
  const alert = (t: number): FixtureEntry[] => [
    { name: '/RealOutputs/PhotonAlerts/warnings', type: 'string[]', records: [[0, []], [t, ['Camera is not connected to the TimeSyncServer']], [t + 1, []]] },
  ]
  const alerts = (extra: FixtureEntry[]) => only(match([...extra, { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[0, []]] }]), 'vision/time-sync')[0]

  it('alerts only before the match (at boot) are info', () => {
    expect(alerts(alert(5)).severity).toBe('info')
  })
  it('an alert during the match stays a warning', () => {
    expect(alerts(alert(100)).severity).toBe('warning')
  })
  it('one at boot and one in the match is still a warning', () => {
    const both: FixtureEntry[] = [
      { name: '/RealOutputs/PhotonAlerts/warnings', type: 'string[]', records: [[0, []], [5, ['Camera is not connected to the TimeSyncServer']], [6, []], [100, ['Camera is not connected to the TimeSyncServer']]] },
    ]
    expect(alerts(both).severity).toBe('warning')
  })
})

describe('power/limit-not-applied severity', () => {
  const amps = (key: string, a: number): FixtureEntry => ({ name: key, type: 'double', records: [[0, 0], [10, a], [410, 0]] })
  const driveMotors = offseason2026.motorGroups.find((g) => g.name.startsWith('Swerve drive') || g.name.toLowerCase().includes('drive'))!
  const flywheel = offseason2026.motorGroups.find((g) => g.name === 'Flywheel')!

  it('the profile has a group with the limit on in code and one with it off', () => {
    expect(driveMotors.limits.supplyEnabled).toBe(true)
    expect(flywheel.limits.supplyEnabled).toBe(false)
  })
  it('a limit that is on in code and still exceeded stays an error', () => {
    const entries = driveMotors.motors.flatMap((m) => [amps(m.supplyCurrent!, 80), amps(m.statorCurrent!, 10)])
    const f = only(match(entries), 'power/limit-not-applied').find((x) => x.key.includes(driveMotors.name) && x.title.includes('supply'))!
    expect(f.severity).toBe('error')
    expect(f.title).not.toMatch(/switched off/)
  })
  it('a limit switched off in code and exceeded is a warning, and the message says why', () => {
    const entries = flywheel.motors.flatMap((m) => [amps(m.supplyCurrent!, 90), amps(m.statorCurrent!, 10)])
    const f = only(match(entries), 'power/limit-not-applied').find((x) => x.title.includes('supply'))!
    expect(f.severity).toBe('warning')
    expect(f.title).toMatch(/switched off in code \(deliberate\?\)/)
  })
})
