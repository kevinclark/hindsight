// mech/stall, mech/slip and loop/stopped-while-enabled on made-up logs for the 2026 competition robot's profile.
// The real cases (2026-02-21 practice) are not in the repo; their numbers are in the rules' comments.
import { describe, expect, it } from 'vitest'
import { competition2026 } from '../src/profiles/2026-competition.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const enabledFrom20To60: FixtureEntry = { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [60, false]] }
const battery: FixtureEntry = { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.5], [70, 12.5]] }

function run(entries: FixtureEntry[]) {
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], competition2026).analyses[0].report
}

const turretStator = (records: [number, number][]): FixtureEntry => ({ name: '/Shooter/Turret/StatorCurrentAmps', type: 'double', records })
const turretStill: FixtureEntry = { name: '/Shooter/Turret/AngularVelocityRotationsPerSec', type: 'double', records: [[10, 0]] }

describe('mech/stall', () => {
  it('fires on a turret pushing 45 A without turning for 2 s', () => {
    const report = run([enabledFrom20To60, battery, turretStill, turretStator([[10, 2], [30, 45], [32, 2]])])
    const stall = report.findings.find((f) => f.rule === 'mech/stall')
    expect(stall?.about).toBe('Turret')
    expect(stall?.evidence['longest stall (s)']).toBe(2)
  })
  it('stays quiet on a 0.3 s stall, a stall while disabled, and a turret that turns', () => {
    expect(fired(run([enabledFrom20To60, battery, turretStill, turretStator([[10, 2], [30, 45], [30.3, 2]])]))).not.toContain('mech/stall')
    expect(fired(run([enabledFrom20To60, battery, turretStill, turretStator([[10, 2], [62, 45], [66, 2]])]))).not.toContain('mech/stall')
    const turning: FixtureEntry = { name: '/Shooter/Turret/AngularVelocityRotationsPerSec', type: 'double', records: [[10, 0], [30, 0.5], [32, 0]] }
    expect(fired(run([enabledFrom20To60, battery, turning, turretStator([[10, 2], [30, 45], [32, 2]])]))).not.toContain('mech/stall')
  })
  it('leaves a group that may stall on purpose alone (the indexer holding a game piece)', () => {
    const report = run([
      enabledFrom20To60, battery,
      { name: '/Indexer/Roller/StatorCurrentAmps', type: 'double', records: [[10, 2], [30, 60], [40, 2]] },
      { name: '/Indexer/Roller/VelocityRotsPerSec', type: 'double', records: [[10, 0]] },
    ])
    expect(fired(report)).not.toContain('mech/stall')
  })
})

const turretMotor = (records: [number, number][]): FixtureEntry => ({ name: '/Shooter/Turret/PositionRotations', type: 'struct:Rotation2d', records })
const turretAbsolute = (records: [number, number][]): FixtureEntry => ({ name: '/RealOutputs/Shooter/Turret/Turret Calculated Rotation', type: 'struct:Rotation2d', records })

describe('mech/slip', () => {
  const motorTurns = turretMotor([[10, 0], [30, 0], [30.5, 1.5], [31, 3]]) // 3 rad (172°) in a second

  it('fires when the turret motor turns 172° in a second and the turret stays put', () => {
    const report = run([enabledFrom20To60, battery, motorTurns, turretAbsolute([[10, 0], [30.5, 0.002]])])
    const slip = report.findings.find((f) => f.rule === 'mech/slip')
    expect(slip?.about).toBe('Turret')
    expect(slip?.evidence['seconds the motor turned and the mechanism did not']).toBe(1)
    expect(slip?.evidence['motor travel in the worst second (°)']).toBe(172)
  })
  it('stays quiet when the turret follows its motor, and when the motor turns while disabled', () => {
    expect(fired(run([enabledFrom20To60, battery, motorTurns, turretAbsolute([[10, 0], [30, 0], [30.5, 1.4], [31, 2.9]])]))).not.toContain('mech/slip')
    const disabledTurn = turretMotor([[10, 0], [62, 0], [63, 3]])
    expect(fired(run([enabledFrom20To60, battery, disabledTurn, turretAbsolute([[10, 0]])]))).not.toContain('mech/slip')
  })
  it('stays quiet on one bad absolute sample at the start of a second', () => {
    // The turret swings −235° in a second and the absolute angle follows, but its sample at the start of that second
    // reads −246° early (as a two-encoder angle can mid-swing), so the second looks like 11° of travel.
    const swing = turretMotor([[10, 0], [30, 0], [30.5, -2], [31, -4.1]])
    const glitch = turretAbsolute([[10, 0], [30, -4.3], [30.1, -0.4], [30.5, -2], [31, -4.1]])
    expect(fired(run([enabledFrom20To60, battery, swing, glitch]))).not.toContain('mech/slip')
  })
  it('stays quiet when the absolute angle lags a fast swing and catches up a second later', () => {
    // The motor swings 3 rad in a second; the absolute angle reads the old angle at the end of that second, then catches up.
    const lagging = turretAbsolute([[10, 0], [30.9, 0.1], [31.5, 3]])
    expect(fired(run([enabledFrom20To60, battery, motorTurns, lagging]))).not.toContain('mech/slip')
  })
})

describe('loop/stopped-while-enabled', () => {
  const endsEnabled: FixtureEntry = { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true]] }
  const batteryTo40: FixtureEntry = { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.5], [40, 12.45]] }

  it('fires on a log that ends 20 s into an enable, and rules out a battery sag at 12.45 V', () => {
    const finding = run([endsEnabled, batteryTo40]).findings.find((f) => f.rule === 'loop/stopped-while-enabled')
    expect(finding?.evidence['enabled for, when the log ends (s)']).toBe(20)
    expect(finding?.causes.find((c) => c.id === 'slow-sag')?.ruledOut).toBeTruthy()
  })
  it('points at a crash when the console says so in the last seconds', () => {
    const console: FixtureEntry = { name: '/RealOutputs/Console', type: 'string', records: [[39, 'Unhandled exception: java.lang.NullPointerException']] }
    const finding = run([endsEnabled, batteryTo40, console]).findings.find((f) => f.rule === 'loop/stopped-while-enabled')
    expect(finding?.causes[0]).toMatchObject({ id: 'crash', likely: true })
  })
  it('stays quiet on a log that ends disabled, and on the field (restart-mid-match covers that)', () => {
    expect(fired(run([enabledFrom20To60, battery]))).not.toContain('loop/stopped-while-enabled')
    const fms: FixtureEntry = { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[10, true]] }
    expect(fired(run([endsEnabled, batteryTo40, fms]))).not.toContain('loop/stopped-while-enabled')
  })
})
