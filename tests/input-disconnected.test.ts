// can/input-disconnected: a "...Connected" input the robot profile doesn't name went false while enabled. One device
// is listed with its episodes; three or more falling within 0.1 s are one event, not that many devices.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const flag = (name: string, records: [number, boolean][]): FixtureEntry => ({ name, type: 'boolean', records })

/** An AdvantageKit log enabled from 20 to 80 s (a gap 40–45 s). Flags start true at 5 s. */
function log(extra: FixtureEntry[], enabled: [number, boolean][] = [[5, false], [20, true], [40, false], [45, true], [80, false]]): FixtureEntry[] {
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: enabled },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[5, 12.5], [90, 12.4]] },
    ...extra,
  ]
}

const findings = (entries: FixtureEntry[]) =>
  analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(entries) }], offseason2025).analyses[0].report.findings.filter((f) => f.rule === 'can/input-disconnected')

describe('can/input-disconnected', () => {
  it('one device: each drop with its time and length, the last one to the end of the match, as an error', () => {
    const [f] = findings(log([
      flag('/Intake/Rollers/LeaderConnected', [[5, true], [30, false], [31.5, true], [60, false]]),
      flag('/Intake/Rollers/FollowerConnected', [[5, true]]),
    ]))
    expect(f.severity).toBe('error')
    expect(f.title).toMatch(/^1 device went disconnected, first at .*robot time 30\.0 s/)
    expect(f.evidence['Intake/Rollers/LeaderConnected']).toMatch(/robot time 30\.0 s\), 1\.5 s; .*robot time 60\.0 s\), to the end of the match$/)
    expect(Object.keys(f.evidence)).toEqual(['Intake/Rollers/LeaderConnected'])
  })

  it('a short blip that came back is a warning', () => {
    const [f] = findings(log([flag('/Drive/Module3/TurnEncoderConnected', [[5, true], [50, false], [50.18, true]])]))
    expect(f.severity).toBe('warning')
    expect(f.evidence['Drive/Module3/TurnEncoderConnected']).toMatch(/0\.18 s$/)
  })

  it('a device off for more than 5 s in total is an error even though it came back', () => {
    const [f] = findings(log([flag('/Vision/Camera0/Connected', [[5, true], [30, false], [37, true]])]))
    expect(f.severity).toBe('error')
  })

  it('leaves out outputs, the roboRIO\'s network clients, NetworkTables copies, drops while disabled, and flags false since boot', () => {
    expect(findings(log([
      flag('/RealOutputs/Intake/FakeConnected', [[5, true], [30, false], [31, true]]),
      flag('/SystemStats/NTClients/Elastic@3/Connected', [[5, true], [30, false], [31, true]]),
      flag('NT:/Intake/Rollers/LeaderConnected', [[5, true], [30, false], [31, true]]),
      flag('/Intake/Rollers/LeaderConnected', [[5, true], [41, false], [42, true]]), // in the 40–45 s gap
      flag('/Intake/Spare/Connected', [[5, false]]),
      flag('/Intake/Rollers/Connectedness', [[5, true], [30, false], [31, true]]), // suffix is case-sensitive and exact
    ]))).toEqual([])
  })

  it('three or more devices falling within 0.1 s are ONE event, not a list of devices', () => {
    const [f] = findings(log([
      flag('/A/DriveConnected', [[5, true], [50, false], [51, true]]),
      flag('/B/DriveConnected', [[5, true], [50.04, false], [51, true]]),
      flag('/C/DriveConnected', [[5, true], [50.1, false], [51, true]]),
      flag('/D/DriveConnected', [[5, true], [50.1, false], [90, true]]),
    ]))
    expect(f.title).toMatch(/^1 drop of several devices at once went disconnected/)
    expect(Object.keys(f.evidence)).toEqual(['4 devices at once'])
    expect(f.evidence['4 devices at once']).toMatch(/^4 devices dropped at once at .*: likely robot power, the CAN bus, or the robot code stopping, not one device \(1 device still off at the end\)$/)
    expect(f.severity).toBe('error') // D stays off to the end of the enabled period
  })

  it('two devices together are still two devices', () => {
    const [f] = findings(log([
      flag('/A/DriveConnected', [[5, true], [50, false], [50.5, true]]),
      flag('/B/DriveConnected', [[5, true], [50.02, false], [50.5, true]]),
    ]))
    expect(Object.keys(f.evidence)).toEqual(['A/DriveConnected', 'B/DriveConnected'])
    expect(f.severity).toBe('warning')
  })

  it('lists at most 8 devices, then how many more', () => {
    const flags = Array.from({ length: 11 }, (_, i) => flag(`/Dev${i}/Connected`, [[5, true], [21 + i, false], [21.5 + i, true]]))
    const [f] = findings(log(flags))
    expect(Object.keys(f.evidence)).toHaveLength(9)
    expect(f.evidence.more).toBe('+3 more')
  })

  it('a log with nothing disconnected has no finding', () => {
    expect(findings(log([flag('/Intake/Rollers/LeaderConnected', [[5, true]])]))).toEqual([])
  })

  it('a drop that starts in the auto-to-teleop gap and runs into teleop counts', () => {
    const [f] = findings(log([flag('/Intake/Rollers/LeaderConnected', [[5, true], [42, false], [60, true]])]))
    expect(f.evidence['Intake/Rollers/LeaderConnected']).toMatch(/robot time 42\.0 s\), 18 s$/)
  })

  it('the group count and the still-off count are devices, not drops', () => {
    const [f] = findings(log([
      flag('/A/DriveConnected', [[5, true], [50, false], [50.01, true], [50.03, false]]), // two drops, one device, off to the end
      flag('/B/DriveConnected', [[5, true], [50.02, false], [51, true]]),
      flag('/C/DriveConnected', [[5, true], [50.04, false], [51, true]]),
    ]))
    expect(f.evidence['3 devices at once']).toMatch(/^3 devices dropped at once.*\(1 device still off at the end\)$/)
  })

  it('a flag false at the first record of a log that starts enabled is not a drop; a plot names each device once', () => {
    const enabled: [number, boolean][] = [[5, true], [80, false]]
    expect(findings(log([flag('/A/Connected', [[5, false], [30, true]])], enabled))).toEqual([])
    const [f] = findings(log([flag('/A/Connected', [[5, true], [30, false], [31, true], [40, false], [41, true]])]))
    expect(f.plot?.lines.length).toBe(1)
  })
})
