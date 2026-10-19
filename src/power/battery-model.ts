/**
 * The power model behind the Power tab and the power/* rules.
 *
 * Total current is the SUM OF MOTOR SUPPLY CURRENTS plus a small constant for everything else.
 * /SystemStats/BatteryCurrent is NOT battery current: it is the roboRIO's own input (~0.5 A).
 *
 * The battery model is the "no-RC" fit from hindsight-research/whatif/battery_model_replay.py:
 *     V = V0 − k·Q − R0·I
 * V bus voltage, Q charge drawn so far (Ah), I total current (A). The RC term in the reference script is left out
 * on purpose: it made P0's slope look 2.7× worse than it was (hindsight-research/REVIEW.md, item 1).
 */

import { has, num, type Match } from '../match/match.ts'
import { makeGrid, median, resample, round } from '../match/series.ts'

export const DT = 0.02 // 50 Hz grid, the robot's loop rate

export interface PowerGrid {
  t: Float64Array
  volts: Float64Array
  /** Total current: motor supply currents + otherLoadsAmps. */
  amps: Float64Array
  /** Charge drawn since the match started (first enable), Ah. Held constant after the match ends. */
  ah: Float64Array
  enabled: Uint8Array
  matchStart: number | null
  matchEnd: number | null
  /** Supply current per motor group, same grid. */
  groups: { name: string; amps: Float64Array }[]
  /** Supply current per motor, same grid (for the what-if). */
  motors: { name: string; group: string; amps: Float64Array }[]
}

/** Resample voltage and every motor's supply current onto one 50 Hz grid. Null if voltage or currents are missing. */
export function buildPowerGrid(match: Match): PowerGrid | null {
  const cached = match.cache.get('power:grid') as PowerGrid | null | undefined
  if (cached !== undefined) return cached
  const grid = computePowerGrid(match)
  match.cache.set('power:grid', grid as never)
  return grid
}

function computePowerGrid(match: Match): PowerGrid | null {
  const p = match.profile
  const voltage = num(match, p.signals.batteryVoltage)
  if (!voltage || voltage.t.length < 2) return null
  const t = makeGrid(voltage.t[0], voltage.t[voltage.t.length - 1], DT)
  return gridWithCurrents(match, t, resample(voltage, t))
}

/**
 * Like buildPowerGrid, but for a log with motor currents and no battery voltage: the grid spans the whole log and
 * `volts` is NaN. With battery voltage it is the power grid itself. Null without motor currents.
 */
export function buildCurrentGrid(match: Match): PowerGrid | null {
  const withVolts = buildPowerGrid(match)
  if (withVolts || has(match, match.profile.signals.batteryVoltage)) return withVolts
  const cached = match.cache.get('power:currents') as PowerGrid | null | undefined
  if (cached !== undefined) return cached
  const t = match.logEnd > match.logStart ? makeGrid(match.logStart, match.logEnd, DT) : new Float64Array(0)
  const grid = t.length < 2 ? null : gridWithCurrents(match, t, new Float64Array(t.length).fill(NaN))
  match.cache.set('power:currents', grid as never)
  return grid
}

/** Every motor's supply current on the grid, summed by group and in total. Null without enabled or any current. */
function gridWithCurrents(match: Match, t: Float64Array, volts: Float64Array): PowerGrid | null {
  const p = match.profile
  const enabled = num(match, p.signals.enabled)
  if (!enabled) return null
  const en = resample(enabled, t, 0)
  const enabledMask = Uint8Array.from(en, (x) => (x > 0.5 ? 1 : 0))

  const amps = new Float64Array(t.length).fill(p.power.otherLoadsAmps)
  const groups: PowerGrid['groups'] = []
  const motors: PowerGrid['motors'] = []
  let anyMotor = false
  for (const group of p.motorGroups) {
    const groupAmps = new Float64Array(t.length)
    for (const motor of group.motors) {
      if (!motor.supplyCurrent || !has(match, motor.supplyCurrent)) continue
      const s = num(match, motor.supplyCurrent)!
      const a = resample(s, t, 0)
      for (let i = 0; i < a.length; i++) {
        const x = Number.isFinite(a[i]) ? Math.max(0, a[i]) : 0
        a[i] = x
        groupAmps[i] += x
        amps[i] += x
      }
      motors.push({ name: motor.name, group: group.name, amps: a })
      anyMotor = true
    }
    groups.push({ name: group.name, amps: groupAmps })
  }
  if (!anyMotor) return null

  const ah = chargeDrawn(t, amps, match.matchStart, match.matchEnd)
  return { t, volts, amps, ah, enabled: enabledMask, matchStart: match.matchStart, matchEnd: match.matchEnd, groups, motors }
}

/** Running charge (Ah) from matchStart to matchEnd; zero before, held after. */
function chargeDrawn(t: Float64Array, amps: Float64Array, from: number | null, to: number | null): Float64Array {
  const ah = new Float64Array(t.length)
  for (let i = 1; i < t.length; i++) {
    const inMatch = from !== null && to !== null && t[i] > from && t[i] <= to
    ah[i] = ah[i - 1] + (inMatch ? (amps[i] * DT) / 3600 : 0)
  }
  return ah
}

export interface BatteryFit {
  v0: number
  /** Open-circuit voltage lost per Ah drawn, V/Ah. */
  kVoltsPerAh: number
  r0Ohms: number
  rmse: number
  rmseLow: number
  samples: number
  lowSamples: number
}

/** Least-squares fit of V = V0 − k·Q − R0·I over enabled samples. */
export function fitBattery(g: PowerGrid): BatteryFit | null {
  // Normal equations for 3 unknowns: [1, −Q, −I] · [V0, k, R0] = V
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const b = [0, 0, 0]
  let n = 0
  for (let i = 0; i < g.t.length; i++) {
    if (!g.enabled[i] || !Number.isFinite(g.volts[i])) continue
    const x = [1, -g.ah[i], -g.amps[i]]
    for (let r = 0; r < 3; r++) {
      b[r] += x[r] * g.volts[i]
      for (let c = 0; c < 3; c++) A[r][c] += x[r] * x[c]
    }
    n++
  }
  if (n < 100) return null
  const sol = solve3(A, b)
  if (!sol) return null
  const [v0, k, r0] = sol
  const fit: BatteryFit = { v0, kVoltsPerAh: k, r0Ohms: r0, rmse: 0, rmseLow: 0, samples: n, lowSamples: 0 }
  const pred = predict(fit, g.ah, g.amps)
  let se = 0, seLow = 0, nLow = 0
  for (let i = 0; i < g.t.length; i++) {
    if (!g.enabled[i] || !Number.isFinite(g.volts[i])) continue
    const e = pred[i] - g.volts[i]
    se += e * e
    if (g.volts[i] < 7.5) { seLow += e * e; nLow++ }
  }
  fit.rmse = Math.sqrt(se / n)
  fit.rmseLow = nLow ? Math.sqrt(seLow / nLow) : NaN
  fit.lowSamples = nLow
  return fit
}

export function predict(fit: BatteryFit, ah: Float64Array, amps: Float64Array): Float64Array {
  const out = new Float64Array(ah.length)
  for (let i = 0; i < ah.length; i++) out[i] = fit.v0 - fit.kVoltsPerAh * ah[i] - fit.r0Ohms * amps[i]
  return out
}

/** Gaussian elimination with partial pivoting for a 3×3 system. */
function solve3(A: number[][], b: number[]): number[] | null {
  const m = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < 3; c++) {
    let pivot = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
}

export interface ResistanceEstimate {
  ohms: number
  steps: number
}

/**
 * Battery + wiring resistance from current steps.
 *
 * In every 1 s window (sliding by 0.2 s) where the robot was enabled and total current swung by at least
 * `minSwingAmps`, fit a straight line V = a − R·I. The median R over all windows is the estimate.
 *
 * Why a window and not two neighbouring samples: voltage and motor currents are logged by different devices at
 * slightly different moments, so a sample-to-sample step reads ≈ 0 mΩ. Over a second the lag washes out.
 * Measured on the CalGames logs: 11.3 / 11.4 / 11.1 mΩ (Q13 / Q21 / P0), matching the 11.4 / 11.3 / 11.0 mΩ in
 * the P0 analysis.
 */
export function resistanceFromSteps(g: PowerGrid, minSwingAmps = 100): ResistanceEstimate | null {
  const window = Math.round(1 / DT)
  const stride = Math.round(0.2 / DT)
  const rs: number[] = []
  for (let start = 0; start + window <= g.t.length; start += stride) {
    let n = 0, sumI = 0, sumV = 0, sumII = 0, sumIV = 0
    let minI = Infinity, maxI = -Infinity
    let usable = true
    for (let j = start; j < start + window; j++) {
      if (!g.enabled[j] || !Number.isFinite(g.volts[j])) { usable = false; break }
      const I = g.amps[j], V = g.volts[j]
      n++; sumI += I; sumV += V; sumII += I * I; sumIV += I * V
      if (I < minI) minI = I
      if (I > maxI) maxI = I
    }
    if (!usable || maxI - minI < minSwingAmps) continue
    const slope = (n * sumIV - sumI * sumV) / (n * sumII - sumI * sumI)
    rs.push(-slope)
  }
  if (rs.length < 20) return null
  return { ohms: median(rs), steps: rs.length }
}

export interface OcvPoint { ah: number; volts: number; t: number }

/**
 * Estimated open-circuit voltage against charge drawn: V + R·I while enabled, the median in each `binAh` bin.
 * This is what the battery would read with no load. A healthy battery stays high as Ah climbs; a weak one falls.
 */
export function ocvCurve(g: PowerGrid, rOhms: number, binAh = 0.25): OcvPoint[] {
  const bins = new Map<number, { v: number[]; t: number[] }>()
  for (let i = 0; i < g.t.length; i++) {
    if (!g.enabled[i] || !Number.isFinite(g.volts[i])) continue
    const b = Math.floor(g.ah[i] / binAh)
    if (!bins.has(b)) bins.set(b, { v: [], t: [] })
    bins.get(b)!.v.push(g.volts[i] + rOhms * g.amps[i])
    bins.get(b)!.t.push(g.t[i])
  }
  return [...bins.entries()]
    .filter(([, x]) => x.v.length >= 25) // at least half a second of samples in the bin
    .sort((a, b) => a[0] - b[0])
    .map(([b, x]) => ({ ah: round((b + 0.5) * binAh, 3), volts: median(x.v), t: median(x.t) }))
}

export interface WhatIf {
  capAmps: number
  mode: 'clip' | 'defer'
  minVolts: number
  secondsUnder7: number
}

/**
 * Replay the match through the fitted model with the what-if group's supply current capped per motor.
 * 'clip' drops the excess current; 'defer' keeps the charge and spends it later, as a slower spin-up would.
 */
export function replayCap(g: PowerGrid, fit: BatteryFit, group: string, capAmps: number, mode: 'clip' | 'defer'): WhatIf {
  const amps = Float64Array.from(g.amps)
  for (const motor of g.motors) {
    if (motor.group !== group) continue
    let debt = 0
    for (let i = 0; i < amps.length; i++) {
      const a = motor.amps[i]
      const want = a + (mode === 'defer' ? debt : 0)
      const capped = a > 0.5 || debt > 0 ? Math.min(want, capAmps) : a
      debt = mode === 'defer' ? want - capped : 0
      amps[i] += capped - a
    }
  }
  const ah = chargeDrawn(g.t, amps, g.matchStart, g.matchEnd)
  const v = predict(fit, ah, amps)
  return { capAmps, mode, ...voltageStats(v, g.enabled) }
}

export function voltageStats(v: Float64Array, enabled: Uint8Array): { minVolts: number; secondsUnder7: number } {
  let min = Infinity
  let under = 0
  for (let i = 0; i < v.length; i++) {
    if (!enabled[i] || !Number.isFinite(v[i])) continue
    if (v[i] < min) min = v[i]
    if (v[i] < 7) under++
  }
  return { minVolts: min, secondsUnder7: under * DT }
}
