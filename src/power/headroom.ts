/**
 * Headroom: how much more each motor had to give while it ran. Per motor, from one log:
 *  - how long it ran (enabled, on CAN, |stator| ≥ 5 A or |applied| ≥ 1 V);
 *  - the share of that time at its stator limit and at its sustained supply cap (the profile's limits);
 *  - how close it ran to its top speed for the battery of that moment: back-EMF ÷ bus voltage, where back-EMF is
 *    k·|velocity| and k comes from a fit of the motor's own log, applied V·sign(v) = k·|v| + R·stator. The fit absorbs
 *    the gear ratio and the motor type, so no ratio or motor table is needed, and the velocity's unit doesn't matter.
 *  - for a group that spins to a setpoint (a flywheel), the voltage its setpoint needs, how often the battery was under
 *    it, and how often the wheel fell short of the setpoint then and otherwise.
 *
 * Phoenix 6 stator current is positive while motoring and negative while regenerating, in either direction, which is
 * why the fit multiplies the voltage by the sign of the velocity. The fit selects samples by speed and current only,
 * never by voltage (selecting on the dependent variable biases R).
 * Measured on 8033's 21 match logs of 2026-10/11: the fit's k matched the Kraken X60's FOC free speed within 1 % on
 * the drive (residual 0.78 V rms) and R came out 0.018-0.030 Ω across five mechanisms, against 0.0248 Ω from the
 * datasheet.
 */

import { has, num, type Match } from '../match/match.ts'
import { resample } from '../match/series.ts'
import { PHOENIX_DEFAULTS, limitOn, limitsKnown } from '../limits/limits-report.ts'
import { sustainedPerMotor } from '../limits/pair.ts'
import type { MotorGroup } from '../profiles/types.ts'
import { buildPowerGrid, DT } from './battery-model.ts'

/** A sample is running at or above these. */
export const RUN_AMPS = 5
export const RUN_VOLTS = 1
/** At a current limit: at or above this share of it. */
export const AT_LIMIT = 0.93
/** Near top speed: back-EMF at or above this share of the bus. */
export const NEAR_TOP = 0.9
/** The battery is under what a setpoint needs: the setpoint's back-EMF at or above this share of the bus. */
export const SETPOINT_PAST_TOP = 0.95
/** Short of a setpoint: under this share of it. */
export const SHORT_OF_SETPOINT = 0.95
/** A setpoint the wheel hasn't reached counts once it has been driven at it this long (s): a spin-up takes ~1 s. */
export const SETTLE_SECONDS = 1.5
/** The fit is used only when its residual is under this (V rms), it has this many samples and its R is positive. */
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

export interface TopSpeed {
  /** Back-EMF ÷ bus over running time: median and 90th percentile. */
  p50: number
  p90: number
  /** Share of running time at or above NEAR_TOP. */
  nearTop: number
}

export interface MotorHeadroom {
  motor: string
  group: string
  runningSeconds: number
  /** Share of running time at ≥ 93 % of the stator limit / the sustained supply cap; null where the profile has none. */
  atStator: number | null
  atSupply: number | null
  fit: SpeedFit | null
  /** Null without a fit or a velocity. */
  topSpeed: TopSpeed | null
  /** Median |stator| (A) and median bus (V) while near top speed; null when it never was. */
  ampsNearTop: number | null
  busNearTop: number | null
  /** The samples behind topSpeed, kept so a group's percentiles pool its motors' samples. */
  samples: { ratios: number[]; nearAmps: number[]; nearBus: number[] }
}

export interface SetpointHeadroom {
  /** Seconds the wheel was held at its setpoint: driven, after reaching 95 % of it or SETTLE_SECONDS at it. */
  seconds: number
  /** Median voltage the setpoint needs (k·|setpoint|) over those seconds. */
  needsVolts: number
  /** Share of those seconds with the battery under what the setpoint needs (setpoint back-EMF ≥ 95 % of the bus). */
  pastTop: number
  /** Share short of the setpoint (under 95 %) while the battery was under it, and the rest of the time. */
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
  topSpeed: TopSpeed | null
  ampsNearTop: number | null
  busNearTop: number | null
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

/** The speed fit of one motor on grid arrays; null when it can't be trusted (too few samples, a bad residual, k or R ≤ 0). */
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
  if (!f || !(f.a > 0) || !(f.b > 0) || !(f.rms < FIT_MAX_RMS)) return null
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

const topSpeedOf = (s: MotorHeadroom['samples']): TopSpeed | null =>
  s.ratios.length ? { p50: quantile(s.ratios, 0.5), p90: quantile(s.ratios, 0.9), nearTop: s.nearAmps.length / s.ratios.length } : null

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
  const samples: MotorHeadroom['samples'] = { ratios: [], nearAmps: [], nearBus: [] }
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue
    const amps = a.stator[i], volts = a.volts[i]
    if (!(Math.abs(amps) >= RUN_AMPS || Math.abs(volts) >= RUN_VOLTS)) continue
    running++
    if (limits.statorA !== null && Math.abs(amps) >= AT_LIMIT * limits.statorA) stator++
    if (limits.supplyA !== null && a.supply && a.supply[i] >= AT_LIMIT * limits.supplyA) supply++
    // Every running sample, so the shares are "of the time it ran", as the words say.
    if (fit && Number.isFinite(a.velocity[i])) {
      const r = (fit.k * Math.abs(a.velocity[i])) / bus[i]
      samples.ratios.push(r)
      if (r >= NEAR_TOP) { samples.nearAmps.push(Math.abs(amps)); samples.nearBus.push(bus[i]) }
    }
  }
  const share = (x: number) => (running ? x / running : 0)
  return {
    motor, group, runningSeconds: running * DT,
    atStator: limits.statorA === null ? null : share(stator),
    atSupply: limits.supplyA === null || !a.supply ? null : share(supply),
    fit,
    topSpeed: topSpeedOf(samples),
    ampsNearTop: samples.nearAmps.length ? quantile(samples.nearAmps, 0.5) : null,
    busNearTop: samples.nearBus.length ? quantile(samples.nearBus, 0.5) : null,
    samples,
  }
}

/**
 * A setpoint group's leader: the voltage its setpoint needs, how often the battery was under it, and the shortfall
 * then and otherwise. Counts only holding time: driven (applied ≥ 1 V) at one setpoint after the wheel reached 95 % of
 * it, or after SETTLE_SECONDS at it (so a setpoint the battery can't reach still counts). Not driven, off CAN, or a
 * setpoint change of more than 2 % starts over, so each spin-up (short by design) is left out.
 */
export function setpointHeadroom(
  k: number, volts: ArrayLike<number>, velocity: ArrayLike<number>, setpoint: ArrayLike<number>, bus: ArrayLike<number>, ok: ArrayLike<number>,
): SetpointHeadroom {
  let seconds = 0, past = 0, shortPast = 0, shortNot = 0
  let held = NaN, reached = false, drivenFor = 0
  const needs: number[] = []
  for (let i = 0; i < bus.length; i++) {
    const s = Math.abs(setpoint[i]), v = Math.abs(velocity[i])
    const driven = ok[i] && s > 0 && Math.abs(volts[i]) >= RUN_VOLTS && bus[i] > 4 && Number.isFinite(v)
    if (!driven || !(Math.abs(s - held) <= 0.02 * s)) { held = driven ? s : NaN; reached = false; drivenFor = 0 }
    if (!driven) continue
    drivenFor += DT
    const short = v < SHORT_OF_SETPOINT * s
    if (!short) reached = true
    if (!reached && drivenFor < SETTLE_SECONDS) continue
    seconds++
    needs.push(k * s)
    if ((k * s) / bus[i] >= SETPOINT_PAST_TOP) { past++; if (short) shortPast++ } else if (short) shortNot++
  }
  return {
    seconds: seconds * DT,
    needsVolts: quantile(needs, 0.5),
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
 * The limits a group's motors are held to, as configured: the stator limit when on (Phoenix's 120 A when on by
 * default), and the sustained supply cap (its lower limit, Phoenix's 40 A after 1 s if unset; limits/pair.ts). Null
 * where the profile has no such limit or doesn't know.
 */
export function headroomLimits(group: MotorGroup): { statorA: number | null; supplyA: number | null } {
  const stator = limitsKnown(group.limits) && limitOn(group.limits, 'stator')
  const supply = sustainedPerMotor(group)
  return {
    statorA: stator ? group.limits.statorA ?? PHOENIX_DEFAULTS.statorA : null,
    supplyA: Number.isFinite(supply) ? supply : null,
  }
}

/** Why there is no Headroom section, when a profile motor logs applied volts but the log has no battery voltage. */
export function headroomMissing(match: Match): string | null {
  if (buildPowerGrid(match)) return null
  const wants = match.profile.motorGroups.some((g) => g.motors.some((m) => m.appliedVolts))
  return wants ? 'Headroom needs the battery voltage, and this log doesn\'t have it.' : null
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
      const limits = headroomLimits(group)
      const motors: MotorHeadroom[] = []
      let leader: { fit: SpeedFit; volts: Float64Array; velocity: Float64Array; ok: Uint8Array } | null = null
      for (const m of group.motors) {
        const volts = series(match, m.appliedVolts, grid.t), stator = series(match, m.statorCurrent, grid.t)
        if (!volts || !stator) continue
        // Without a velocity the limit shares still stand; top speed needs it.
        const velocity = series(match, m.velocity, grid.t) ?? new Float64Array(grid.t.length).fill(NaN)
        const flag = series(match, m.connected, grid.t)
        const connected = flag ? Uint8Array.from(flag, (x) => (x === 0 ? 0 : 1)) : new Uint8Array(grid.t.length).fill(1)
        // The power grid already holds each motor's supply current on the same grid.
        const supply = grid.motors.find((x) => x.name === m.name && x.group === group.name)?.amps
        const h = motorHeadroom(m.name, group.name, { volts, velocity, stator, supply, connected }, grid.volts, grid.enabled, limits)
        motors.push(h)
        if (!leader && h.fit && m.velocity) {
          const ok = new Uint8Array(grid.t.length)
          for (let i = 0; i < ok.length; i++) ok[i] = grid.enabled[i] && connected[i] ? 1 : 0
          leader = { fit: h.fit, volts, velocity, ok }
        }
      }
      if (!motors.length) continue
      const sp = leader ? series(match, group.spinUp?.setpoint, grid.t) : null
      out.push({
        ...combine(group.name, motors), statorLimitA: limits.statorA, supplyLimitA: limits.supplyA,
        setpoint: leader && sp ? setpointHeadroom(leader.fit.k, leader.volts, leader.velocity, sp, grid.volts, leader.ok) : null,
      })
    }
  }
  match.cache.set('power:headroom', out as never)
  return out
}

/** A group's numbers: its longest-running motor's time, limit shares weighted by running time, top speed pooled. */
function combine(group: string, motors: MotorHeadroom[]): Omit<GroupHeadroom, 'statorLimitA' | 'supplyLimitA' | 'setpoint'> {
  const weighted = (pick: (m: MotorHeadroom) => number | null): number | null => {
    const xs = motors.filter((m) => pick(m) !== null && m.runningSeconds > 0)
    const w = xs.reduce((s, m) => s + m.runningSeconds, 0)
    return w > 0 ? xs.reduce((s, m) => s + pick(m)! * m.runningSeconds, 0) / w : null
  }
  const pooled = {
    ratios: motors.flatMap((m) => m.samples.ratios),
    nearAmps: motors.flatMap((m) => m.samples.nearAmps),
    nearBus: motors.flatMap((m) => m.samples.nearBus),
  }
  return {
    group, motors,
    runningSeconds: Math.max(...motors.map((m) => m.runningSeconds)),
    atStator: weighted((m) => m.atStator),
    atSupply: weighted((m) => m.atSupply),
    topSpeed: topSpeedOf(pooled),
    ampsNearTop: pooled.nearAmps.length ? quantile(pooled.nearAmps, 0.5) : null,
    busNearTop: pooled.nearBus.length ? quantile(pooled.nearBus, 0.5) : null,
  }
}

/** A verdict fires at or above these (see headroomVerdicts). */
export const PAST_TOP_SHARE = 0.1
/** The wheel fell short this often while the battery was under the setpoint, and twice as often as the rest. */
export const SHORT_FLOOR = 0.3
export const NEAR_TOP_SHARE = 0.4
/** "Light" current near top speed: under this share of the stator limit, or under LIGHT_AMPS without one. */
export const LIGHT_SHARE = 0.5
export const LIGHT_AMPS = 15
/** A group needs this much running time (s) for any verdict: a pit log's few seconds say little. */
export const VERDICT_MIN_SECONDS = 30

export interface HeadroomVerdict {
  group: string
  kind: 'battery under the setpoint' | 'at top speed'
  says: string
  tryThis: string
}

const pc = (x: number) => `${Math.round(100 * x)} %`

/**
 * What the numbers say, in words, with what to try. Each verdict was first seen on 8033's 2026 offseason robot, in
 * its 14 MTTD 2026 match logs:
 *  - battery under the setpoint: the drum's setpoint needs 5.9-6.9 V; the battery sagged under that in 0-19 % of its
 *    holding time, and the wheel fell short of it then far more often than the rest of the time. It is a battery
 *    reading (no log has a setpoint past top speed on a rested battery), so the advice is the battery.
 *  - at top speed: the intake rollers within 10 % of top speed 44-69 % of the time they ran, at 5-11 A against a
 *    20 A stator limit. Drive motors (ours, and one public log each of 2151, 2204, 3467, 4322, 5414) reached at most
 *    29 %, at 14-31 A.
 * The limit shares get no words. No log in hand has a stator-limit case, and the drive sat at its 40 A supply cap
 * 30-50 % of the time in every one of 19 match logs: a line that fires every match says nothing, and no outside log
 * has limits to say what share means trouble (Kevin, 2026-11-10: the number only).
 */
export function headroomVerdicts(groups: GroupHeadroom[]): HeadroomVerdict[] {
  const out: HeadroomVerdict[] = []
  for (const g of groups) {
    if (g.runningSeconds < VERDICT_MIN_SECONDS) continue
    const sp = g.setpoint
    if (sp && sp.pastTop >= PAST_TOP_SHARE && sp.shortWhenPastTop !== null && sp.shortWhenPastTop >= SHORT_FLOOR
      && sp.shortOtherwise !== null && sp.shortWhenPastTop >= 2 * sp.shortOtherwise) {
      out.push({
        group: g.group, kind: 'battery under the setpoint',
        says: `${g.group}: its setpoint needs ${sp.needsVolts.toFixed(1)} V. The battery was under that ${pc(sp.pastTop)} of the time it held speed, and the wheel fell short ${pc(sp.shortWhenPastTop)} of that time (${pc(sp.shortOtherwise)} the rest).`,
        tryThis: 'See the sags above, and try a fresher battery.',
      })
    }
    const light = g.ampsNearTop !== null && g.ampsNearTop < (g.statorLimitA !== null ? LIGHT_SHARE * g.statorLimitA : LIGHT_AMPS)
    if (g.topSpeed && g.topSpeed.nearTop >= NEAR_TOP_SHARE && light) {
      out.push({
        group: g.group, kind: 'at top speed',
        says: `${g.group}: within 10 % of top speed ${pc(g.topSpeed.nearTop)} of the time it ran, at ${Math.round(g.ampsNearTop!)} A on a ${g.busNearTop!.toFixed(1)} V battery (median). Torque to spare, no speed left.`,
        tryThis: 'If more speed would help (picking up while driving fast, say), test that on the practice field first; a gear ratio with less reduction would give it.',
      })
    }
  }
  return out
}
