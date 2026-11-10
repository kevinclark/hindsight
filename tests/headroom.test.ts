// Headroom (src/power/headroom.ts): how much more each motor had. Synthetic series built from the motor model
// V = k·|v| + R·I, then the verdicts at their thresholds, then the team's 2026 logs (tests/helpers/team-logs.ts).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { motorsFromLog } from '../src/builder/motors.ts'
import {
  buildHeadroom, headroomVerdicts, motorHeadroom, setpointHeadroom, speedFit, LIGHT_AMPS, NEAR_TOP_SHARE, PAST_TOP_SHARE, SUPPLY_SHARE,
  type GroupHeadroom,
} from '../src/power/headroom.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'

const K = 0.02, R = 0.025, N = 3000
const ones = (n = N) => new Float64Array(n).fill(1)
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
  it('returns null with too few samples or a residual it can\'t trust', () => {
    const m = model(300)
    expect(speedFit(m.volts, m.velocity, m.stator, ones(300))).toBeNull()
    const noisy = model()
    for (let i = 0; i < N; i++) noisy.volts[i] += 3 * Math.sin(i * 1.7)
    expect(speedFit(noisy.volts, noisy.velocity, noisy.stator, ones())).toBeNull()
  })
  it('never selects by voltage: samples where V opposes the motion still count', () => {
    const m = model()
    const ok = ones()
    const f1 = speedFit(m.volts, m.velocity, m.stator, ok)!
    // Samples off CAN are left out entirely.
    ok.fill(0, 0, N / 2)
    expect(speedFit(m.volts, m.velocity, m.stator, ok)!.k).toBeCloseTo(f1.k, 3)
  })
})

describe('motorHeadroom', () => {
  it('shares limits and top speed over the time the motor ran', () => {
    const m = model()
    const bus = new Float64Array(N).fill(10)
    const supply = new Float64Array(N).fill(10); supply.fill(40, 0, N / 4) // a quarter at a 40 A supply limit
    const h = motorHeadroom('m', 'g', { ...m, supply, connected: ones() }, bus, ones(), { statorA: 55, supplyA: 40 })
    expect(h.runningSeconds).toBeCloseTo(N * 0.02, 6)
    expect(h.atSupply).toBeCloseTo(0.25, 6)
    // stator 10..56 A: only the top steps reach 93 % of 55 A
    expect(h.atStator).toBeGreaterThan(0)
    expect(h.atStator).toBeLessThan(0.2)
    // speed 50..450 at k 0.02 on a 10 V bus: back-EMF/bus 0.1..0.9
    expect(h.topSpeed!.p50).toBeCloseTo(0.5, 1)
    expect(h.topSpeed!.nearTop).toBeLessThan(0.02)
  })
  it('has no limit share where the profile has no enabled limit, and no top speed without a fit', () => {
    const m = model(200)
    const h = motorHeadroom('m', 'g', { ...m, connected: ones(200) }, new Float64Array(200).fill(10), ones(200), { statorA: null, supplyA: null })
    expect(h.atStator).toBeNull()
    expect(h.atSupply).toBeNull()
    expect(h.topSpeed).toBeNull()
  })
  it('leaves out time disabled or off CAN', () => {
    const m = model()
    const en = ones(); en.fill(0, 0, N / 2)
    const conn = ones(); conn.fill(0, N / 2, (3 * N) / 4)
    const h = motorHeadroom('m', 'g', { ...m, connected: conn }, new Float64Array(N).fill(10), en, { statorA: null, supplyA: null })
    expect(h.runningSeconds).toBeCloseTo((N / 4) * 0.02, 6)
  })
})

describe('setpointHeadroom', () => {
  const n = 1000
  it('skips the spin-up, then counts short time at and below top speed for the bus', () => {
    const v = new Float64Array(n), s = new Float64Array(n).fill(50), V = new Float64Array(n).fill(9), bus = new Float64Array(n).fill(10)
    for (let i = 0; i < n; i++) v[i] = i < 100 ? 0.4 * i : 50 // spin-up under 95 % for 100 samples, then held
    for (let i = 600; i < 700; i++) v[i] = 45 // a dip: under 95 %
    // past top for the bus from sample 500 on: k·s/bus = 0.2·50/10 = 1.0
    const k = 0.2, busLow = bus.map((b, i) => (i < 500 ? 20 : b))
    const h = setpointHeadroom(k, V, v, s, busLow, ones(n))
    expect(h.seconds).toBeCloseTo((n - 100) * 0.02, 6)
    expect(h.pastTop).toBeCloseTo(500 / 900, 6)
    expect(h.shortWhenPastTop).toBeCloseTo(100 / 500, 6)
    expect(h.shortOtherwise).toBe(0)
  })
  it('starts over when the setpoint moves more than 2 %', () => {
    const v = new Float64Array(n).fill(50), s = new Float64Array(n).fill(50)
    s.fill(60, 500) // a new setpoint the wheel never reaches
    const h = setpointHeadroom(0.1, new Float64Array(n).fill(9), v, s, new Float64Array(n).fill(12), ones(n))
    expect(h.seconds).toBeCloseTo(500 * 0.02, 6)
  })
})

const group = (over: Partial<GroupHeadroom>): GroupHeadroom => ({
  group: 'G', motors: [], runningSeconds: 100, atStator: null, atSupply: null, topSpeed: null, ampsNearTop: null, statorLimitA: null, supplyLimitA: null, setpoint: null, ...over,
})

describe('headroomVerdicts', () => {
  it('says out of power at the supply-limit share, not under it', () => {
    expect(headroomVerdicts([group({ atSupply: SUPPLY_SHARE, supplyLimitA: 40 })])[0]).toMatchObject({ kind: 'out of power' })
    expect(headroomVerdicts([group({ atSupply: SUPPLY_SHARE - 0.01, supplyLimitA: 40 })])).toEqual([])
  })
  it('says setpoint past top speed only when it fell short there at least twice as often', () => {
    const sp = { seconds: 30, pastTop: PAST_TOP_SHARE, shortWhenPastTop: 0.6, shortOtherwise: 0.1 }
    expect(headroomVerdicts([group({ setpoint: sp })])[0]).toMatchObject({ kind: 'setpoint past top speed' })
    expect(headroomVerdicts([group({ setpoint: { ...sp, shortWhenPastTop: 0.15 } })])).toEqual([])
    expect(headroomVerdicts([group({ setpoint: { ...sp, pastTop: PAST_TOP_SHARE - 0.01 } })])).toEqual([])
  })
  it('says speed to spare near top speed with light current only', () => {
    const top = { p50: 0.9, p90: 0.99, nearTop: NEAR_TOP_SHARE }
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: 8, statorLimitA: 20 })])[0]).toMatchObject({ kind: 'speed to spare' })
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: 12, statorLimitA: 20 })])).toEqual([]) // not under half the limit
    expect(headroomVerdicts([group({ topSpeed: top, ampsNearTop: LIGHT_AMPS })])).toEqual([]) // no limit: under 15 A
    expect(headroomVerdicts([group({ topSpeed: { ...top, nearTop: NEAR_TOP_SHARE - 0.01 }, ampsNearTop: 8, statorLimitA: 20 })])).toEqual([])
  })
})

describe('the builder finds a motor\'s applied voltage', () => {
  const d = (name: string): FixtureEntry => ({ name, type: 'double', records: [[1, 1], [2, 2]] })
  it('takes AppliedVolts or Voltage beside the motor, never a requested or supply voltage', () => {
    const log = openWpilog(writeWpilog([
      d('/Drive/Module0/DriveStatorCurrentAmps'), d('/Drive/Module0/DriveVelocityRadPerSec'), d('/Drive/Module0/DriveAppliedVolts'),
      d('/Intake/Roller/StatorCurrentAmps'), d('/Intake/Roller/VelocityRotPerSec'), d('/Intake/Roller/Requested Voltage'), d('/Intake/Roller/SupplyVoltage'),
      d('/Drum/Leader/StatorCurrentAmps'), d('/Drum/Leader/VelocityRotPerSec'), d('/Drum/Leader/Voltage'),
    ]))
    const byPath = Object.fromEntries(motorsFromLog(log).motors.map((m) => [m.path, m.appliedVolts]))
    expect(byPath).toEqual({ '/Drive/Module0/Drive': '/Drive/Module0/DriveAppliedVolts', '/Intake/Roller': undefined, '/Drum/Leader': '/Drum/Leader/Voltage' })
  })
})

const LOG_B = teamPath(TEAM.logB)
describe.skipIf(!existsSync(LOG_B))('headroom on the team\'s 2026 log B', () => {
  it('reads the drive out of power and the intake rollers with speed to spare', () => {
    const match = analyzeFiles([{ name: 'logB.wpilog', bytes: new Uint8Array(readFileSync(LOG_B)) }]).analyses[0].match
    const h = buildHeadroom(match)
    expect(h.find((g) => g.group === 'Drive')!.atSupply).toBeGreaterThan(SUPPLY_SHARE)
    expect(h.find((g) => g.group === 'Intake rollers')!.topSpeed!.nearTop).toBeGreaterThan(NEAR_TOP_SHARE)
    expect(headroomVerdicts(h).map((v) => `${v.group}: ${v.kind}`)).toEqual(expect.arrayContaining(['Drive: out of power', 'Intake rollers: speed to spare']))
  })
})
