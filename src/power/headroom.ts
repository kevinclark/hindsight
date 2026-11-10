/**
 * Headroom: how much more each motor had to give while it ran. Per motor, from one log:
 *  - how long it ran (enabled, on CAN, |stator| ≥ 5 A or |applied| ≥ 1 V);
 *  - the share of that time at its stator limit and at its supply limit (the profile's limits, when enabled);
 *  - how close it ran to its top speed for the battery of that moment: back-EMF ÷ bus voltage, where back-EMF is
 *    k·|velocity| and k comes from a fit of the motor's own log, applied V·sign(v) = k·|v| + R·stator. The fit absorbs
 *    the gear ratio and the motor type, so no ratio or motor table is needed, and the velocity's unit doesn't matter.
 *  - for a group that spins to a setpoint (a flywheel), how often the setpoint itself was at or past top speed for the
 *    bus, and how often the wheel fell short of it there and elsewhere.
 *
 * Phoenix 6 stator current is positive while motoring and negative while regenerating, in either direction, which is
 * why the fit multiplies the voltage by the sign of the velocity. The fit selects samples by speed and current only,
 * never by voltage (selecting on the dependent variable biases R).
 * Measured on 8033's 21 match logs of 2026-10/11:
 * the fit's k matched the Kraken X60's FOC free speed within 1 % on the drive (residual 0.78 V rms) and R came out
 * 0.018-0.030 Ω across five mechanisms, against 0.0248 Ω from the datasheet.
 */

import { has, num, type Match } from '../match/match.ts'
import { resample } from '../match/series.ts'
import { buildPowerGrid, DT } from './battery-model.ts'

/** A sample is running at or above these. */
export const RUN_AMPS = 5
export const RUN_VOLTS = 1
/** At a current limit: at or above this share of it. */
export const AT_LIMIT = 0.93
/** Near top speed: back-EMF at or above this share of the bus. */
export const NEAR_TOP = 0.9
/** A setpoint at or past top speed for the bus. */
export const SETPOINT_PAST_TOP = 0.95
/** Short of a setpoint: under this share of it. */
export const SHORT_OF_SETPOINT = 0.95
/** The fit is used only when its residual is under this (V rms) and it has this many samples. */
export const FIT_MAX_RMS = 1.5
export const FIT_MIN_SAMPLES = 500
/** Fit samples: |velocity| above this share of the motor's p99 speed, stator above FIT_MIN_AMPS. */
const FIT_MIN_SPEED_SHARE = 0.15
const FIT_MIN_AMPS = 5

export interface SpeedFit {
  /** Volts per (velocity unit): back-EMF = k·|v|. */
  k: number
  /** Ω, the motor's apparent resistance. */
  ohms: number
  rmsVolts: number
  samples: number
}

export interface MotorHeadroom {
  motor: string
  group: string
  runningSeconds: number
  /** Share of running time at ≥ 93 % of the stator / supply limit; null where the profile has no enabled limit. */
  atStator: number | null
  atSupply: number | null
  fit: SpeedFit | null
  /** Back-EMF ÷ bus over running, motoring samples: p50, p90, and the share at or above NEAR_TOP. Null without a fit. */
  topSpeed: { p50: number; p90: number; nearTop: number } | null
  /** Median |stator| while near top speed (A), or null when it never was. */
  ampsNearTop: number | null
}

export interface SetpointHeadroom {
  /** Seconds the wheel was held at its setpoint: driven, after first reaching 95 % of it. */
  seconds: number
  /** Share of those seconds with the setpoint's back-EMF at or past SETPOINT_PAST_TOP of the bus. */
  pastTop: number
  /** Share short of the setpoint (under 95 %) while past top, and while not. Null where there was no such time. */
  shortWhenPastTop: number | null
  shortOtherwise: number | null
}

export interface GroupHeadroom {
  group: string
  motors: MotorHeadroom[]
  /** Its longest-running motor's running time, s. */
  runningSeconds: number
  atStator: number | null
  atSupply: number | null
  topSpeed: { p50: number; p90: number; nearTop: number } | null
  ampsNearTop: number | null
  statorLimitA: number | null
  supplyLimitA: number | null
  setpoint: SetpointHeadroom | null
}

/** Least squares of y = a·x1 + b·x2 (no intercept). */
export function fit2(x1: number[], x2: number[], y: number[]): { a: number; b: number; rms: number } | null {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0
  for (let i = 0; i < y.length; i++) { s11 += x1[i] * x1[i]; s12 += x1[i] * x2[i]; s22 += x2[i] * x2[i]; s1y += x1[i] * y[i]; s2y += x2[i] * y[i] }
  const det = s11 * s22 - s12 * s12
  if (!(Math.abs(det) > 1e-12)) return null
  const a = (s1y * s22 - s2y * s12) / det, b = (s2y * s11 - s1y * s12) / det
  let e = 0
  for (let i = 0; i < y.length; i++) { const r = y[i] - a * x1[i] - b * x2[i]; e += r * r }
  return { a, b, rms: Math.sqrt(e / y.length) }
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : NaN
}

/** The speed fit of one motor on grid arrays; null when it can't be trusted (too few samples, a bad residual, k ≤ 0). */
export function speedFit(volts: ArrayLike<number>, velocity: ArrayLike<number>, stator: ArrayLike<number>, ok: ArrayLike<number>): SpeedFit | null {
  const speeds: number[] = []
  for (let i = 0; i < velocity.length; i++) if (ok[i] && Number.isFinite(velocity[i])) speeds.push(Math.abs(velocity[i]))
  const p99 = quantile(speeds, 0.99)
  if (!(p99 > 0)) return null
  const w: number[] = [], amps: number[] = [], v: number[] = []
  for (let i = 0; i < velocity.length; i++) {
    if (!ok[i] || !Number.isFinite(volts[i]) || !Number.isFinite(stator[i]) || !Number.isFinite(velocity[i])) continue
    const s = Math.abs(velocity[i])
    if (s < FIT_MIN_SPEED_SHARE * p99 || stator[i] < FIT_MIN_AMPS) continue
    w.push(s); amps.push(stator[i]); v.push(volts[i] * Math.sign(velocity[i]))
  }
  if (w.length < FIT_MIN_SAMPLES) return null
  const f = fit2(w, amps, v)
  if (!f || !(f.a > 0) || !(f.rms < FIT_MAX_RMS)) return null
  return { k: f.a, ohms: f.b, rmsVolts: f.rms, samples: w.length }
}

export interface MotorArrays {
  volts: ArrayLike<number>
  velocity: ArrayLike<number>
  stator: ArrayLike<number>
  supply?: ArrayLike<number>
  /** 1 where the controller is on CAN (all ones when the profile has no Connected flag). */
  connected: ArrayLike<number>
}

/** One motor's headroom on grid arrays. Pure, so tests can feed synthetic series. */
export function motorHeadroom(
  motor: string, group: string, a: MotorArrays, bus: ArrayLike<number>, enabled: ArrayLike<number>,
  limits: { statorA: number | null; supplyA: number | null },
): MotorHeadroom {
  const n = bus.length
  const ok = new Uint8Array(n)
  for (let i = 0; i < n; i++) ok[i] = enabled[i] && a.connected[i] && bus[i] > 4 ? 1 : 0
  const fit = speedFit(a.volts, a.velocity, a.stator, ok)
  let running = 0, stator = 0, supply = 0
  const ratios: number[] = [], nearAmps: number[] = []
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue
    const amps = a.stator[i], volts = a.volts[i]
    if (!(Math.abs(amps) >= RUN_AMPS || Math.abs(volts) >= RUN_VOLTS)) continue
    running++
    if (limits.statorA !== null && Math.abs(amps) >= AT_LIMIT * limits.statorA) stator++
    if (limits.supplyA !== null && a.supply && a.supply[i] >= AT_LIMIT * limits.supplyA) supply++
    if (fit && amps > RUN_AMPS && Number.isFinite(a.velocity[i])) {
      const r = (fit.k * Math.abs(a.velocity[i])) / bus[i]
      ratios.push(r)
      if (r >= NEAR_TOP) nearAmps.push(Math.abs(amps))
    }
  }
  const share = (x: number) => (running ? x / running : 0)
  return {
    motor, group, runningSeconds: running * DT,
    atStator: limits.statorA === null ? null : share(stator),
    atSupply: limits.supplyA === null || !a.supply ? null : share(supply),
    fit,
    topSpeed: ratios.length ? { p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9), nearTop: nearAmps.length / ratios.length } : null,
    ampsNearTop: nearAmps.length ? quantile(nearAmps, 0.5) : null,
  }
}

/**
 * A setpoint group's leader: how often its setpoint sat at or past top speed for the bus, and the shortfall there.
 * Counts only holding time: driven (applied ≥ 1 V) after the wheel first reached 95 % of the current setpoint, so a
 * spin-up from rest or to a new setpoint (short by design) is left out. A setpoint change of more than 2 % starts over.
 */
export function setpointHeadroom(
  k: number, volts: ArrayLike<number>, velocity: ArrayLike<number>, setpoint: ArrayLike<number>, bus: ArrayLike<number>, ok: ArrayLike<number>,
): SetpointHeadroom {
  let seconds = 0, past = 0, shortPast = 0, shortNot = 0
  let held = NaN, reached = false
  for (let i = 0; i < bus.length; i++) {
    const s = Math.abs(setpoint[i]), v = Math.abs(velocity[i])
    if (!(Math.abs(s - held) <= 0.02 * s)) { held = s; reached = false }
    if (!ok[i] || !(s > 0) || !(Math.abs(volts[i]) >= RUN_VOLTS) || !(bus[i] > 4) || !Number.isFinite(v)) continue
    const short = v < SHORT_OF_SETPOINT * s
    if (!reached) { if (short) continue; reached = true }
    seconds++
    if ((k * s) / bus[i] >= SETPOINT_PAST_TOP) { past++; if (short) shortPast++ } else if (short) shortNot++
  }
  return {
    seconds: seconds * DT,
    pastTop: seconds ? past / seconds : 0,
    shortWhenPastTop: past ? shortPast / past : null,
    shortOtherwise: seconds - past ? shortNot / (seconds - past) : null,
  }
}

const series = (match: Match, key: string | undefined, t: Float64Array): Float64Array | null => {
  if (!key || !has(match, key)) return null
  try {
    const s = num(match, key)
    return s && s.t.length ? resample(s, t) : null
  } catch {
    return null // a signal that isn't a number or a boolean
  }
}

/**
 * Every profile motor group with at least one motor that logs applied volts and stator current: its headroom (top
 * speed only for motors that also log velocity). Needs the battery voltage. Cached as power:headroom.
 */
export function buildHeadroom(match: Match): GroupHeadroom[] {
  const cached = match.cache.get('power:headroom') as unknown as GroupHeadroom[] | undefined
  if (cached) return cached
  const out: GroupHeadroom[] = []
  const grid = buildPowerGrid(match)
  if (grid) {
    for (const group of match.profile.motorGroups) {
      const L = group.limits
      const limits = { statorA: L.statorEnabled && L.statorA ? L.statorA : null, supplyA: L.supplyEnabled && L.supplyA ? L.supplyA : null }
      const motors: MotorHeadroom[] = []
      let leader: { fit: SpeedFit; volts: Float64Array; velocity: Float64Array; ok: Uint8Array } | null = null
      for (const m of group.motors) {
        const volts = series(match, m.appliedVolts, grid.t), stator = series(match, m.statorCurrent, grid.t)
        if (!volts || !stator) continue
        // Without a velocity the limit shares still stand; top speed needs it.
        const velocity = series(match, m.velocity, grid.t) ?? new Float64Array(grid.t.length).fill(NaN)
        const flag = series(match, m.connected, grid.t)
        const connected = flag ? Uint8Array.from(flag, (x) => (x === 0 ? 0 : 1)) : new Uint8Array(grid.t.length).fill(1)
        const h = motorHeadroom(m.name, group.name, { volts, velocity, stator, supply: series(match, m.supplyCurrent, grid.t) ?? undefined, connected }, grid.volts, grid.enabled, limits)
        motors.push(h)
        if (!leader && h.fit) {
          const ok = new Uint8Array(grid.t.length)
          for (let i = 0; i < ok.length; i++) ok[i] = grid.enabled[i] && connected[i] ? 1 : 0
          leader = { fit: h.fit, volts, velocity, ok }
        }
      }
      if (!motors.length) continue
      const sp = leader ? series(match, group.spinUp?.setpoint, grid.t) : null
      out.push({ ...combine(group.name, motors), statorLimitA: limits.statorA, supplyLimitA: limits.supplyA, setpoint: leader && sp ? setpointHeadroom(leader.fit.k, leader.volts, leader.velocity, sp, grid.volts, leader.ok) : null })
    }
  }
  match.cache.set('power:headroom', out as never)
  return out
}

/** A group's numbers: its longest-running motor's time, shares and percentiles weighted by each motor's running time. */
function combine(group: string, motors: MotorHeadroom[]): Omit<GroupHeadroom, 'statorLimitA' | 'supplyLimitA' | 'setpoint'> {
  const runningSeconds = Math.max(...motors.map((m) => m.runningSeconds))
  const weighted = (pick: (m: MotorHeadroom) => number | null): number | null => {
    const xs = motors.filter((m) => pick(m) !== null && m.runningSeconds > 0)
    const w = xs.reduce((s, m) => s + m.runningSeconds, 0)
    return xs.length && w > 0 ? xs.reduce((s, m) => s + pick(m)! * m.runningSeconds, 0) / w : null
  }
  const withTop = motors.filter((m) => m.topSpeed)
  return {
    group, motors, runningSeconds,
    atStator: weighted((m) => m.atStator),
    atSupply: weighted((m) => m.atSupply),
    topSpeed: withTop.length
      ? { p50: weighted((m) => m.topSpeed?.p50 ?? null)!, p90: weighted((m) => m.topSpeed?.p90 ?? null)!, nearTop: weighted((m) => m.topSpeed?.nearTop ?? null)! }
      : null,
    ampsNearTop: weighted((m) => m.ampsNearTop),
  }
}

/** A verdict fires at or above these (see headroomVerdicts). */
export const SUPPLY_SHARE = 0.25
export const PAST_TOP_SHARE = 0.1
export const NEAR_TOP_SHARE = 0.4
/** "Light" current near top speed: under this share of the stator limit, or under LIGHT_AMPS without one. */
export const LIGHT_SHARE = 0.5
export const LIGHT_AMPS = 15

export interface HeadroomVerdict {
  group: string
  kind: 'out of power' | 'setpoint past top speed' | 'speed to spare'
  says: string
  /** What to try, in order. */
  tryThis: string
}

const pc = (x: number) => `${Math.round(100 * x)} %`

/**
 * What the numbers say, in words, with what to try. Each verdict was first seen on 8033's 2026 offseason robot, at
 * MTTD 2026, with these shares per match log:
 *  - out of power: the drive at its 40 A supply limit 38-50 % of the time it ran (every MTTD log). A ratio change
 *    can't add power, so the advice is the battery and the limit, not the gearing.
 *  - setpoint past top speed: the drum's setpoint at or past top speed for the battery 0-19 % of its holding time,
 *    and short of it there 68-100 % of that time against 10-20 % otherwise.
 *  - speed to spare: the intake rollers within 10 % of top speed 43-68 % of the time at 8-9 A (20 A stator limit).
 *    Every drive motor stayed at or under 24 %, at 14-31 A: ours and those in one public log each of 2151, 2204, 3467,
 *    4322 and 5414.
 * No log in hand has a stator-limit verdict: the share is shown with no words until a case is seen.
 */
export function headroomVerdicts(groups: GroupHeadroom[]): HeadroomVerdict[] {
  const out: HeadroomVerdict[] = []
  for (const g of groups) {
    const supplyA = g.atSupply !== null ? limitText(g) : null
    if (g.atSupply !== null && g.atSupply >= SUPPLY_SHARE) {
      out.push({
        group: g.group, kind: 'out of power',
        says: `${g.group}: at the${supplyA} supply limit ${pc(g.atSupply)} of the time it ran.`,
        tryThis: 'Check the batteries it ran on and whether the supply limit is the one you meant. A different gear ratio won\'t add power.',
      })
    }
    const sp = g.setpoint
    if (sp && sp.pastTop >= PAST_TOP_SHARE && sp.shortWhenPastTop !== null && sp.shortOtherwise !== null && sp.shortWhenPastTop >= 2 * sp.shortOtherwise) {
      out.push({
        group: g.group, kind: 'setpoint past top speed',
        says: `${g.group}: the setpoint was at or past top speed for the battery ${pc(sp.pastTop)} of the time it held speed, and the wheel fell short of it there ${pc(sp.shortWhenPastTop)} of that time (${pc(sp.shortOtherwise)} the rest).`,
        tryThis: 'Try a fresher battery first. If it still falls short, test a lower setpoint, or a gear ratio with less reduction, on the practice field.',
      })
    }
    const light = g.ampsNearTop !== null && g.ampsNearTop < (g.statorLimitA !== null ? LIGHT_SHARE * g.statorLimitA : LIGHT_AMPS)
    if (g.topSpeed && g.topSpeed.nearTop >= NEAR_TOP_SHARE && light) {
      out.push({
        group: g.group, kind: 'speed to spare',
        says: `${g.group}: within 10 % of top speed ${pc(g.topSpeed.nearTop)} of the time it ran, at ${Math.round(g.ampsNearTop!)} A. Torque to spare, no speed left.`,
        tryThis: 'If more speed would help (picking up while driving fast, say), test that on the practice field first; a gear ratio with less reduction would give it.',
      })
    }
  }
  return out
}

function limitText(g: GroupHeadroom): string {
  return g.supplyLimitA !== null ? ` ${g.supplyLimitA} A` : ''
}
