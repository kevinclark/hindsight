// A CAN drop that began before the robot enabled (a device off from boot): dated from the enable, not left out of
// the voltage check as "NaN", and counted only for the time the robot was enabled. Also the held value in
// Signal.lowest()/highest() and the "at before the match" wording.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { matchWhenAt, type Match } from '../src/match/match.ts'
import { voltageList } from '../src/rules/can/bus.ts'
import { Signal } from '../src/rules/view.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const WALL = 1762637000 // epoch seconds

/** A 2025-robot log, enabled from 20 to 80 s with a 40–45 s gap. The battery is first logged at `batteryFrom`. */
function log(extra: FixtureEntry[], batteryFrom = 5): FixtureEntry[] {
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[5, false], [20, true], [40, false], [45, true], [80, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[5, (WALL + 5) * 1e6], [90, (WALL + 90) * 1e6]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[batteryFrom, 12.5], [90, 12.4]] },
    ...extra,
  ]
}

const findings = (entries: FixtureEntry[], rule: string) =>
  analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(entries) }], offseason2025).analyses[0].report.findings.filter((f) => f.rule === rule)

describe('can/device-dropout: a device already off when the robot enabled', () => {
  const gyro = (records: [number, boolean][]): FixtureEntry => ({ name: '/Swerve/Gyro/IsConnected', type: 'boolean', records })

  it('is dated from the enable, says nothing about the battery, and counts only enabled time', () => {
    // Off from boot (5 s) until 25 s: 5 s of that is enabled. Off again 50–52 s, at 12.5 V.
    const [f] = findings(log([gyro([[5, false], [25, true], [50, false], [52, true]])]), 'can/device-dropout')
    expect(f.title).toMatch(/^Gyro \(Pigeon\) dropped off CAN 2 times, first already off when the robot enabled at 0:00 into the match/)
    expect(f.title).not.toMatch(/before the match|NaN/)
    expect(f.time).toBe(20)
    expect(f.evidence['seconds missing']).toBe(7)
    expect(f.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('already off when enabled, 12.50')
    // The one drop that began while enabled still decides: the battery stayed up.
    expect(f.causes.find((c) => c.id === 'battery-sag')?.ruledOut).toMatch(/stayed above 7 V/)
  })

  it('a device off from boot to the end of the log makes no claim about the battery', () => {
    const [f] = findings(log([gyro([[5, false]])]), 'can/device-dropout')
    expect(f.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('already off when enabled')
    expect(f.causes.find((c) => c.id === 'battery-sag')?.ruledOut).toBeUndefined()
    expect(f.causes.find((c) => c.id === 'battery-sag')?.likely).toBeUndefined()
    expect(f.evidence['seconds missing']).toBe(55) // 20–40 and 45–80
  })

  it('a drop that begins while enabled is dated where it began, with its own voltage', () => {
    const [f] = findings(log([gyro([[5, true], [30, false], [31, true]])]), 'can/device-dropout')
    expect(f.title).toMatch(/first at 0:\d\d into the match/)
    expect(f.time).toBe(30)
    expect(f.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('12.50')
  })
})

describe('can/bus-dropout: the voltage list', () => {
  const modules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']
  it('says "not logged" where the battery has no reading, never NaN', () => {
    // The whole bus is off from 5 s, and the battery is first logged at 6 s: no reading just before the drop.
    const status = (m: string): FixtureEntry => ({ name: `/RealOutputs/Module${m}refresh status code`, type: 'string', records: [[5, 'CanMessageStale'], [30, 'OK']] })
    const entries = log([{ name: '/Swerve/Gyro/IsConnected', type: 'boolean', records: [[5, false], [30, true]] }, ...modules.map(status)], 6)
    const [f] = findings(entries, 'can/bus-dropout')
    expect(f).toBeDefined()
    expect(f.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('not logged')
    expect(JSON.stringify(f)).not.toContain('NaN')
  })
  it('formats two decimals', () => {
    expect(voltageList([6.5, NaN, 12])).toBe('6.50, not logged, 12.00')
  })
})

describe('Signal.lowest() and highest() hold the last value before a window', () => {
  const series = { name: 's', t: new Float64Array([1, 10]), v: new Float64Array([5, 9]) }
  const signal = new Signal('s', 's', series, 20)
  it('a window with no record inside', () => {
    expect(signal.lowest([{ start: 3, end: 4 }])).toEqual({ value: 5, at: 3 })
    expect(signal.highest([{ start: 3, end: 4 }])).toEqual({ value: 5, at: 3 })
  })
  it('a record inside the window still counts, and the held value competes with it', () => {
    const w = [{ start: 3, end: 12 }]
    expect(signal.lowest(w)).toEqual({ value: 5, at: 3 })
    expect(signal.highest(w)).toEqual({ value: 9, at: 10 })
  })
  it('each window of a list is held separately', () => {
    expect(signal.highest([{ start: 0, end: 2 }, { start: 11, end: 12 }])).toEqual({ value: 9, at: 11 })
  })
  it('NaN only when nothing was recorded at or before the window', () => {
    expect(signal.lowest([{ start: 0, end: 0.5 }]).value).toBeNaN()
    expect(signal.highest([{ start: 0, end: 0.5 }]).value).toBeNaN()
  })
})

describe('matchWhenAt: "at" only where a time follows', () => {
  const match = { matchStart: 10, matchEnd: 100, auto: [], teleop: [{ start: 10, end: 100 }] } as unknown as Match
  it('during, before and after the match', () => {
    expect(matchWhenAt(match, 20)).toMatch(/^at 0:10 into the match/)
    expect(matchWhenAt(match, 5)).toBe('before the match (robot time 5.0 s)')
    expect(matchWhenAt(match, 120)).toBe('after the match (robot time 120.0 s)')
  })
  it('a log with no match: robot time', () => {
    expect(matchWhenAt({ matchStart: null, matchEnd: null } as unknown as Match, 7)).toBe('at robot time 7.0 s')
  })
})
