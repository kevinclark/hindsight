// Headroom (src/power/headroom.ts): how much more each motor had. Synthetic series built from the motor model
// V = k·|v| + R·I, the setpoint's holding time, the verdicts at their thresholds, a whole synthetic log through the
// 2026 profile (so CI covers buildHeadroom), then the team's 2026 log B (tests/helpers/team-logs.ts).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { motorsFromLog } from '../src/builder/motors.ts'
import {
  buildHeadroom, headroomLimits, headroomVerdicts, motorHeadroom, setpointHeadroom, speedFit,
  LIGHT_AMPS, NEAR_TOP_SHARE, PAST_TOP_SHARE, SHORT_FLOOR, SUPPLY_SHARE, VERDICT_MIN_SECONDS, type GroupHeadroom,
} from '../src/power/headroom.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { MotorGroup } from '../src/profiles/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'

const K = 0.02, R = 0.025, N = 3000
const ones = (n = N) => new Float64Array(n).fill(1)
const flat = (x: number, n = N) => new Float64Array(n).fill(x)
/** A motor sweeping speeds 50-450 under 10-60 A, with its voltage from the model and a little noise. */
function model(n = N, k = K, ohms = R) {
  const velocity = new Float64Array(n), stator = new Float64Array(n), volts = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    velocity[i] = (i % 2 ? 1 : -1) * (50 + (400 * i) / n)
    stator[i] = 10 + 50 * ((i * 7) % 13) / 13
    volts[i] = Math.sign(velocity[i]) * (k * Math.abs(velocity[i]) + ohms * stator[i] + 0.05 * Math.sin(i))
  }
  return { velocity, stator, volts }
}

describe('speedFit', () => {
  it('recovers k and R from V·sign(v) = k·|v| + R·I, either direction', () => {
    const m = model()
    const f = speedFit(m.volts, m.velocity, m.stator, ones())!
    expect(f.k).toBeCloseTo(K, 3)
    expect(f.ohms).toBeCloseTo(R, 3)
    expect(f.rmsVolts).toBeLessThan(0.1)
  })
  it('returns null with too few samples, a residual it can\'t trust, or R at or below 0', () => {
    const m = model(300)
    expect(speedFit(m.volts, m.velocity, m.stator, ones(300))).toBeNull()
    const noisy = model()
    for (let i = 0; i < N; i++) noisy.volts[i] += 3 * Math.sin(i * 1.7)
    expect(speedFit(noisy.volts, noisy.velocity, noisy.stator, ones())).toBeNull()
    const negative = model(N, K, -0.01)
    expect(speedFit(negative.volts, negative.velocity, negative.stator, ones())).toBeNull()
  })
  it('selects by speed and current, never by voltage: samples whose voltage opposes the motion still count', () => {
    const m = model()
    const f1 = speedFit(m.volts, m.velocity, m.stator, ones())!
    // Flip the voltage of 20 samples (plugging): a voltage filter would drop them, and the sample count would fall.
    for (let i = 0; i < 40; i += 2) m.volts[i] = -m.volts[i]
    const f2 = speedFit(m.volts, m.velocity, m.stator, ones())
    expect(f2?.samples).toBe(f1.samples)
  })
  it('leaves out samples off CAN or disabled', () => {
    const m = model()
    const ok = ones(); ok.fill(0, 0, N / 2)
    expect(speedFit(m.volts, m.velocity, m.stator, ok)!.samples).toBeLessThan(speedFit(m.volts, m.velocity, m.stator, ones())!.samples)
  })
})

describe('motorHeadroom', () => {
  it('shares limits and top speed over the time the motor ran', () => {
    const m = model()
    const supply = flat(10); supply.fill(40, 0, N / 4) // a quarter at a 40 A supply cap
    const h = motorHeadroom('m', 'g', { ...m, supply, connected: ones() }, flat(10), ones(), { statorA: 55, supplyA: 40 })
    expect(h.runningSeconds).toBeCloseTo(N * 0.02, 6)
    expect(h.atSupply).toBeCloseTo(0.25, 6)
    expect(h.atStator).toBeGreaterThan(0)
    expect(h.atStator).toBeLessThan(0.2)
    // speed 50..450 at k 0.02 on a 10 V bus: back-EMF/bus 0.1..0.9
    expect(h.topSpeed!.p50).toBeCloseTo(0.5, 1)
    expect(h.topSpeed!.nearTop).toBeLessThan(0.02)
  })
  it('counts light-current running time near top speed in the share, as "of the time it ran" says', () => {
    const m = model()
    // Then 1000 samples spinning free near top speed at 2 A, driven with 9.5 V on a 10 V bus.
    const n = N + 1000
    const cat = (a: Float64Array, v: number) => { const x = new Float64Array(n); x.set(a); x.fill(v, N); return x }
    const h = motorHeadroom('m', 'g', { volts: cat(m.volts, 9.5), velocity: cat(m.velocity, 470), stator: cat(m.stator, 2), connected: ones(n) }, flat(10, n), ones(n), { statorA: null, supplyA: null })
    expect(h.topSpeed!.nearTop).toBeGreaterThan(0.24)
    expect(h.ampsNearTop).toBe(2)
    expect(h.busNearTop).toBe(10)
  })
  it('has no limit share where the profile has no limit, and no top speed without a fit', () => {
    const m = model(200)
    const h = motorHeadroom('m', 'g', { ...m, connected: ones(200) }, flat(10, 200), ones(200), { statorA: null, supplyA: null })
    expect(h.atStator).toBeNull()
    expect(h.atSupply).toBeNull()
    expect(h.topSpeed).toBeNull()
  })
  it('leaves out time disabled or off CAN', () => {
    const m = model()
    const en = ones(); en.fill(0, 0, N / 2)
    const conn = ones(); conn.fill(0, N / 2, (3 * N) / 4)
    const h = motorHeadroom('m', 'g', { ...m, connected: conn }, flat(10), en, { statorA: null, supplyA: null })
    expect(h.runningSeconds).toBeCloseTo((N / 4) * 0.02, 6)
  })
})

describe('headroomLimits', () => {
  const g = (limits: MotorGroup['limits']): MotorGroup => ({ name: 'G', motors: [], limits })
  it('holds a motor to its supply lower limit (Phoenix\'s 40 A when unset), never above its supply limit', () => {
    expect(headroomLimits(g({ supplyA: 70, supplyEnabled: true, where: 'x' })).supplyA).toBe(40)
    expect(headroomLimits(g({ supplyA: 30, supplyEnabled: true, where: 'x' })).supplyA).toBe(30)
    expect(headroomLimits(g({ supplyA: 60, supplyEnabled: true, supplyLowerA: 50, supplyLowerSeconds: 1, where: 'x' })).supplyA).toBe(50)
    expect(headroomLimits(g({ supplyA: 40, supplyEnabled: false, where: 'x' })).supplyA).toBeNull()
  })
  it('knows no limit when the profile doesn\'t', () => {
    expect(headroomLimits(g({ where: 'not read from the robot code' }))).toEqual({ statorA: null, supplyA: null })
  })
})

describe('setpointHeadroom', () => {
  const n = 1000
  it('skips the spin-up, then counts short time with the battery under the setpoint and the rest', () => {
    const v = new Float64Array(n), s = flat(50, n), V = flat(9, n)
    for (let i = 0; i < n; i++) v[i] = i < 40 ? 1.2 * i : 50 // spin-up under 95 % for 40 samples, then held
    for (let i = 600; i < 700; i++) v[i] = 45 // a dip: under 95 %
    // needs 0.2·50 = 10 V: the battery is under that from sample 500 on
    const bus = flat(20, n).fill(10, 500)
    const h = setpointHeadroom(0.2, V, v, s, bus, ones(n))
    expect(h.seconds).toBeCloseTo((n - 40) * 0.02, 6)
    expect(h.needsVolts).toBeCloseTo(10, 9)
    expect(h.pastTop).toBeCloseTo(500 / 960, 6)
    expect(h.shortWhenPastTop).toBeCloseTo(100 / 500, 6)
    expect(h.shortOtherwise).toBe(0)
  })
  it('starts over after the wheel coasts undriven, even at the same setpoint', () => {
    const v = flat(50, n), s = flat(50, n), V = flat(9, n)
    V.fill(0, 300, 400) // coasting between shots: not driven
    for (let i = 400; i < 440; i++) v[i] = 30 + 0.4 * (i - 400) // the next spin-up, still under 95 %
    const h = setpointHeadroom(0.1, V, v, s, flat(12, n), ones(n))
    expect(h.seconds).toBeCloseTo((n - 100 - 40) * 0.02, 6)
    expect(h.shortOtherwise).toBe(0)
  })
  it('counts a setpoint the wheel never reaches once it has been driven at it for 1.5 s', () => {
    const h = setpointHeadroom(0.2, flat(9, n), flat(40, n), flat(50, n), flat(9, n), ones(n))
    expect(h.seconds).toBeCloseTo((n - 74) * 0.02, 6)
    expect(h.pastTop).toBe(1)
    expect(h.shortWhenPastTop).toBe(1)
  })
  it('starts over when the setpoint moves more than 2 %', () => {
    const s = flat(50, n).fill(60, 500) // a new setpoint the wheel never reaches
    const h = setpointHeadroom(0.1, flat(9, n), flat(50, n), s, flat(12, n), ones(n))
    expect(h.seconds).toBeCloseTo((n - 74) * 0.02, 6)
  })
})

const group = (over: Partial<GroupHeadroom>): GroupHeadroom => ({
  group: 'G', motors: [], runningSeconds: 100, atStator: null, atSupply: null, topSpeed: null, ampsNearTop: null, busNearTop: null,
  statorLimitA: null, supplyLimitA: null, setpoint: null, ...over,
})

describe('headroomVerdicts', () => {
  it('says out of power at the supply-cap share, not under it', () => {
    expect(headroomVerdicts([group({ atSupply: SUPPLY_SHARE, supplyLimitA: 40 })])[0]).toMatchObject({ kind: 'out of power' })
    expect(headroomVerdicts([group({ atSupply: SUPPLY_SHARE - 0.01, supplyLimitA: 40 })])).toEqual([])
  })
  it('says the battery was under the setpoint only with a real shortfall, twice the rest', () => {
    const sp = { seconds: 30, needsVolts: 6.8, pastTop: PAST_TOP_SHARE, shortWhenPastTop: 0.6, shortOtherwise: 0.1 }
    expect(headroomVerdicts([group({ setpoint: sp })])[0]).toMatchObject({ kind: 'battery under the setpoint' })
    expect(headroomVerdicts([group({ setpoint: { ...sp, shortWhenPastTop: 0.15 } })])).toEqual([])
    expect(headroomVerdicts([group({ setpoint: { ...sp, shortWhenPastTop: SHORT_FLOOR - 0.01, shortOtherwise: 0 } })])).toEqual([])
    expect(headroomVerdicts([group({ setpoint: { ...sp, pastTop: PAST_TOP_SHARE - 0.01 } })])).toEqual([])
  })
  it('says at top speed with light current only', () => {
    const top = { p50: 0.9, p90: 0.99, nearTop: NEAR_TOP_SHARE }
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: 8, busNearTop: 9, statorLimitA: 20 })])[0]).toMatchObject({ kind: 'at top speed' })
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: 12, busNearTop: 9, statorLimitA: 20 })])).toEqual([]) // not under half the limit
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: LIGHT_AMPS, busNearTop: 9 })])).toEqual([]) // no limit: under 15 A
    expect(headroomVerdicts([group({ topSpeed: { ...top, nearTop: NEAR_TOP_SHARE - 0.01 }, ampsNearTop: 8, busNearTop: 9, statorLimitA: 20 })])).toEqual([])
  })
  it('says nothing about a group that ran under 30 s', () => {
    expect(headroomVerdicts([group({ runningSeconds: VERDICT_MIN_SECONDS - 1, atSupply: 0.9, supplyLimitA: 40 })])).toEqual([])
  })
})

describe('the builder finds a motor\'s applied voltage', () => {
  const d = (name: string): FixtureEntry => ({ name, type: 'double', records: [[1, 1], [2, 2]] })
  it('takes AppliedVolts or Voltage beside the motor, never a requested or supply voltage, and a named one first', () => {
    const log = openWpilog(writeWpilog([
      d('/Drive/Module0/DriveStatorCurrentAmps'), d('/Drive/Module0/DriveVelocityRadPerSec'), d('/Drive/Module0/DriveAppliedVolts'),
      d('/Intake/Roller/StatorCurrentAmps'), d('/Intake/Roller/VelocityRotPerSec'), d('/Intake/Roller/Requested Voltage'), d('/Intake/Roller/SupplyVoltage'),
      d('/Drum/Leader/StatorCurrentAmps'), d('/Drum/Leader/VelocityRotPerSec'), d('/Drum/Leader/Voltage'),
      d('/Hood/StatorCurrentAmps'), d('/Hood/Velocity'), d('/Hood/Voltage'), d('/Hood/AppliedVoltage'),
    ]))
    const byPath = Object.fromEntries(motorsFromLog(log).motors.map((m) => [m.path, m.appliedVolts]))
    expect(byPath).toEqual({
      '/Drive/Module0/Drive': '/Drive/Module0/DriveAppliedVolts', '/Intake/Roller': undefined, '/Drum/Leader': '/Drum/Leader/Voltage', '/Hood': '/Hood/AppliedVoltage',
    })
  })
})

/** A 60 s log, enabled 2-58 s, through the 2026 profile: the flywheel leader at a setpoint the battery sags under for 10 s. */
function synthetic() {
  const t = Array.from({ length: 3001 }, (_, i) => i * 0.02)
  const series = (name: string, v: (x: number) => number | boolean, type = 'double'): FixtureEntry => ({ name, type, records: t.map((x) => [x, v(x)]) })
  const k = 0.17, speed = (x: number) => 40 + 30 * Math.sin(x), amps = (x: number) => 20 + 10 * Math.cos(3 * x)
  const bus = (x: number) => (x > 40 && x < 50 ? 6.5 : 11)
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog([
    series('/DriverStation/Enabled', (x) => x >= 2 && x < 58, 'boolean'),
    series('/SystemStats/BatteryVoltage', bus),
    series('/Drum/Flywheel/Leader/VelocityRotPerSec', speed),
    series('/Drum/Flywheel/Leader/StatorCurrentAmps', amps),
    series('/Drum/Flywheel/Leader/SupplyCurrentAmps', (x) => amps(x) / 2),
    series('/Drum/Flywheel/Leader/Voltage', (x) => k * speed(x) + 0.025 * amps(x)),
    series('/Drum/Flywheel/Leader/Connected', () => true, 'boolean'),
    series('/RealOutputs/Drum/Flywheel/Setpoint', () => 40),
  ]) }], offseason2026).analyses[0]
}

describe('buildHeadroom on a synthetic log', () => {
  it('reads the flywheel from the profile, fits k, and joins its setpoint; cached under power:headroom', () => {
    const { match } = synthetic()
    const h = buildHeadroom(match)
    expect(h.map((g) => g.group)).toEqual(['Flywheel'])
    const fly = h[0]
    expect(fly.motors[0].fit!.k).toBeCloseTo(0.17, 2)
    expect(fly.statorLimitA).toBe(75)
    expect(fly.supplyLimitA).toBeNull() // the profile's flywheel supply limit is off
    expect(fly.setpoint!.needsVolts).toBeCloseTo(0.17 * 40, 1)
    expect(fly.setpoint!.pastTop).toBeGreaterThan(0)
    expect(buildHeadroom(match)).toBe(h)
  })
})

const LOG_B = teamPath(TEAM.logB)
describe.skipIf(!existsSync(LOG_B))('headroom on the team\'s 2026 log B', () => {
  it('reads the drive out of power and the intake rollers at top speed', () => {
    const match = analyzeFiles([{ name: 'logB.wpilog', bytes: new Uint8Array(readFileSync(LOG_B)) }]).analyses[0].match
    const h = buildHeadroom(match)
    expect(h.find((g) => g.group === 'Drive')!.atSupply).toBeGreaterThan(SUPPLY_SHARE)
    expect(h.find((g) => g.group === 'Intake rollers')!.topSpeed!.nearTop).toBeGreaterThan(NEAR_TOP_SHARE)
    expect(headroomVerdicts(h).map((v) => `${v.group}: ${v.kind}`)).toEqual(expect.arrayContaining(['Drive: out of power', 'Intake rollers: at top speed']))
  })
})
