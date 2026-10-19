/**
 * The limits wizard's measurements: find each spin-up in a log, measure it, check the limit the student set really
 * took effect, check the runs are comparable, and pick the recommended limit at the knee.
 *
 * A spin-up starts when the leader's speed leaves standstill (above 2 rot/s after at least 0.5 s below it) and
 * reaches its target: the logged setpoint if there is one, else the speed it settles at. "Time to setpoint" is the
 * time to get within 10 % of the target. (Holding speed, the CalGames flywheel ripples ±5 % around its setpoint, so
 * a tighter band measures the ripple, not the spin-up. With 10 %, Q13's spin-ups take ~0.7 s, as in the P0 analysis.)
 */

import { has, num, values, type Match } from '../match/match.ts'
import { indexAt, median, valueAt, type NumberSeries } from '../match/series.ts'
import type { MotorGroup } from '../profiles/types.ts'

export const STANDSTILL = 2 // rot/s
export const REACHED = 0.9 // of the target speed
export const SHOT_DIP = 0.85 // a ball going through pulls the wheel below this fraction of the target

export interface SpinUp {
  start: number
  /** Seconds to get within 10 % of the target (NaN if it never did within 5 s). */
  timeToSetpoint: number
  target: number
  /** Peak supply current per motor during the spin-up, A. */
  peakSupply: { motor: string; amps: number }[]
  /** Most common 2 A bin of supply samples ≥ 30 A, per motor (null if no sample reached 30 A). */
  plateau: { motor: string; amps: number | null }[]
  /** Each motor's supply current during the spin-up, [time, amps], for the "did the limit take?" check. */
  supply: { motor: string; samples: [number, number][] }[]
  /** Battery voltage just before, and the lowest during. */
  startVolts: number
  dipVolts: number
  batteryId: string | null
}

/** Find every spin-up from standstill of a group (the first motor is the leader). */
export function findSpinUps(match: Match, group: MotorGroup): SpinUp[] {
  const leaderKey = group.motors[0].velocity
  if (!leaderKey || !has(match, leaderKey)) return []
  const v = num(match, leaderKey)!
  const setpoint = group.spinUp?.setpoint && has(match, group.spinUp.setpoint) ? num(match, group.spinUp.setpoint) : null
  const battery = num(match, match.profile.signals.batteryVoltage)
  const applied = group.spinUp?.appliedVolts && has(match, group.spinUp.appliedVolts) ? num(match, group.spinUp.appliedVolts) : null
  const out: SpinUp[] = []
  let stillSince = -Infinity
  for (let i = 0; i < v.t.length; i++) {
    const speed = Math.abs(v.v[i])
    if (speed <= STANDSTILL) { if (stillSince === -Infinity) stillSince = v.t[i]; continue }
    const wasStill = i > 0 && Math.abs(v.v[i - 1]) <= STANDSTILL && v.t[i] - stillSince >= 0.5
    stillSince = -Infinity
    if (!wasStill) continue
    // Speed is logged only when it changes, so the last "still" record can be long before the wheel moved. The
    // spin-up starts when the leader's applied voltage came on (within 0.5 s before it moved), else when it moved.
    const moved = v.t[i]
    const start = applied ? voltageOnAt(applied, moved - 0.5, moved) ?? moved : moved
    // Only real spin-ups: the robot enabled and the leader being driven (not a wheel turned by hand).
    const enabled = match.enabled.some((iv) => start >= iv.start && start < iv.end)
    const driven = !applied || Math.abs(valueAt(applied, moved)) > 1
    if (enabled && driven) out.push(measure(match, group, v, setpoint, battery, start))
  }
  return out.filter((s) => s.target > 10) // ignore nudges
}

/** The first time in [from, to] the applied voltage went above 1 V, or null. */
function voltageOnAt(applied: NumberSeries, from: number, to: number): number | null {
  for (let i = Math.max(0, indexAt(applied.t, from)); i < applied.t.length && applied.t[i] <= to; i++) {
    if (Math.abs(applied.v[i]) > 1) return Math.max(from, applied.t[i])
  }
  return null
}

function measure(match: Match, group: MotorGroup, v: NumberSeries, setpoint: NumberSeries | null, battery: NumberSeries | null, start: number): SpinUp {
  // Target: the setpoint shortly after the start if logged; else the median speed 1.5–2.5 s in.
  const sp = setpoint ? valueAt(setpoint, start + 0.3) : NaN
  const settled: number[] = []
  for (let i = indexAt(v.t, start + 1.5); i >= 0 && i < v.t.length && v.t[i] <= start + 2.5; i++) settled.push(Math.abs(v.v[i]))
  const target = Number.isFinite(sp) && sp > 0 ? sp : median(settled)
  let reachedAt = NaN
  for (let i = Math.max(0, indexAt(v.t, start)); i < v.t.length && v.t[i] <= start + 5; i++) {
    if (Math.abs(v.v[i]) >= REACHED * target) { reachedAt = v.t[i]; break }
  }
  const end = Number.isFinite(reachedAt) ? reachedAt + 0.2 : start + 5
  const peakSupply: SpinUp['peakSupply'] = []
  const plateau: SpinUp['plateau'] = []
  const supply: SpinUp['supply'] = []
  for (const m of group.motors) {
    if (!m.supplyCurrent || !has(match, m.supplyCurrent)) continue
    const s = num(match, m.supplyCurrent)!
    const samples: [number, number][] = []
    for (let i = Math.max(0, indexAt(s.t, start)); i < s.t.length && s.t[i] <= end; i++) if (s.t[i] >= start) samples.push([s.t[i], Math.abs(s.v[i])])
    const inWindow = samples.map(([, a]) => a)
    peakSupply.push({ motor: m.name, amps: inWindow.reduce((a, b) => Math.max(a, b), 0) })
    plateau.push({ motor: m.name, amps: modalBin(inWindow.filter((a) => a >= 30), 2) })
    supply.push({ motor: m.name, samples })
  }
  let startVolts = NaN, low = NaN
  if (battery) {
    startVolts = median(battery.v.filter((_, i) => battery.t[i] >= start - 0.5 && battery.t[i] < start))
    for (let i = Math.max(0, indexAt(battery.t, start)); i < battery.t.length && battery.t[i] <= end; i++) if (!(battery.v[i] >= low)) low = battery.v[i]
  }
  const idKey = match.profile.battery.id.find((k) => has(match, k))
  const batteryId = idKey ? (values<string>(match, idKey)!.v.filter((x) => x).at(-1) ?? null) : null
  return { start, timeToSetpoint: Number.isFinite(reachedAt) ? reachedAt - start : NaN, target, peakSupply, plateau, supply, startVolts, dipVolts: startVolts - low, batteryId }
}

/** The most common bin (width `binA`) of a list of currents, as the bin's centre. Null when the list is empty. */
export function modalBin(amps: number[], binA: number): number | null {
  if (amps.length === 0) return null
  const counts = new Map<number, number>()
  for (const a of amps) { const b = Math.floor(a / binA); counts.set(b, (counts.get(b) ?? 0) + 1) }
  let best = 0, bestCount = -1
  for (const [b, c] of counts) if (c > bestCount || (c === bestCount && b < best)) { best = b; bestCount = c }
  return (best + 0.5) * binA
}

export interface TookEffect {
  ok: boolean
  /** One line per motor that didn't hold the limit, in plain words. */
  problems: string[]
  /** Per motor: held at the limit, never needed to hold, or didn't take. */
  motors: { motor: string; verdict: 'held at the limit' | 'never had to hold' | 'did not take'; modeA: number | null; secondsOver: number }[]
}

/**
 * Did the supply limit the student set take effect on every motor?
 *
 * Didn't take: the motor spent more than 0.2 s (in one run) above 110 % of the limit. A limiter that is working only
 * overshoots briefly (≤ 0.21 s at CalGames).
 * Held at the limit: the most common 2 A bin of samples ≥ 30 A is within ±10 % of the limit (the brief's check;
 * Q13 drive at 40 A: mode 38–40 A while p99 is 46–53 A, so peaks and p99 aren't judged).
 * Never had to hold: neither. The motor drew less than the limit most of the time, so the run can't show the limit
 * holding, but nothing went over it either. (The brief's modal check alone calls these failures: on the CalGames
 * spin-ups at 60 A the mode is 33–39 A.)
 */
export function settingTookEffect(runs: SpinUp[], limitA: number): TookEffect {
  const problems: string[] = []
  const verdicts: TookEffect['motors'] = []
  const motors = [...new Set(runs.flatMap((r) => r.plateau.map((p) => p.motor)))]
  for (const motor of motors) {
    const modes = runs.map((r) => r.plateau.find((p) => p.motor === motor)?.amps).filter((a): a is number => a !== null && a !== undefined)
    const modeA = modes.length ? median(modes) : null
    const secondsOver = Math.max(0, ...runs.map((r) => longestAbove(r.supply.find((s) => s.motor === motor)?.samples ?? [], 1.1 * limitA)))
    const peak = Math.max(0, ...runs.map((r) => r.peakSupply.find((p) => p.motor === motor)?.amps ?? 0))
    if (secondsOver > 0.2) {
      verdicts.push({ motor, verdict: 'did not take', modeA, secondsOver })
      problems.push(`${motor} still at ${peak.toFixed(0)} A (over ${(1.1 * limitA).toFixed(0)} A for ${secondsOver.toFixed(2)} s), not held at ${limitA} A: was the limit saved on every motor?`)
    } else {
      const held = modeA !== null && Math.abs(modeA - limitA) <= 0.1 * limitA
      verdicts.push({ motor, verdict: held ? 'held at the limit' : 'never had to hold', modeA, secondsOver })
    }
  }
  return { ok: problems.length === 0, problems, motors: verdicts }
}

/** Longest stretch (hold-last) a list of [time, amps] samples stayed above `amps`. */
function longestAbove(samples: [number, number][], amps: number): number {
  let longest = 0, since = NaN
  for (let i = 0; i < samples.length; i++) {
    const [t, a] = samples[i]
    if (a > amps) { if (Number.isNaN(since)) since = t }
    else if (!Number.isNaN(since)) { longest = Math.max(longest, t - since); since = NaN }
  }
  if (!Number.isNaN(since) && samples.length) longest = Math.max(longest, samples[samples.length - 1][0] - since)
  return longest
}

export interface Comparable { ok: boolean; problems: string[] }

/** Runs can only be compared on the same battery, starting within 0.3 V, to the same setpoint (±2 %). */
export function runsComparable(runs: { batteryId: string | null; startVolts: number; target: number; label: string }[]): Comparable {
  const problems: string[] = []
  const ids = new Set(runs.map((r) => r.batteryId ?? '(no battery ID)'))
  if (ids.size > 1) problems.push(`different batteries: ${[...ids].join(', ')}`)
  const volts = runs.map((r) => r.startVolts).filter(Number.isFinite)
  if (volts.length && Math.max(...volts) - Math.min(...volts) > 0.3) {
    problems.push(`starting voltages ${Math.min(...volts).toFixed(2)}–${Math.max(...volts).toFixed(2)} V are more than 0.3 V apart`)
  }
  const targets = runs.map((r) => r.target)
  if (targets.length && Math.max(...targets) > 1.02 * Math.min(...targets)) {
    problems.push(`different setpoints: ${Math.min(...targets).toFixed(1)}–${Math.max(...targets).toFixed(1)} rot/s`)
  }
  return { ok: problems.length === 0, problems }
}

export interface SweepPoint { limitA: number | null; timeToSetpoint: number; peakGroupA: number; dipVolts: number }

/** One point per sweep step: medians over its runs. */
export function summarize(limitA: number | null, runs: SpinUp[]): SweepPoint {
  return {
    limitA,
    timeToSetpoint: median(runs.map((r) => r.timeToSetpoint)),
    peakGroupA: median(runs.map((r) => r.peakSupply.reduce((s, p) => s + p.amps, 0))),
    dipVolts: median(runs.map((r) => r.dipVolts)),
  }
}

/**
 * The recommended limit: the lowest one whose spin-up time is within `slowerBy` (default 20 %) of the no-limit run.
 * Null when there is no no-limit baseline yet.
 */
export function recommend(points: SweepPoint[], slowerBy = 0.2): { limitA: number; baseline: number } | null {
  const base = points.find((p) => p.limitA === null)
  if (!base || !Number.isFinite(base.timeToSetpoint)) return null
  const ok = points.filter((p) => p.limitA !== null && p.timeToSetpoint <= base.timeToSetpoint * (1 + slowerBy))
  if (ok.length === 0) return null
  return { limitA: Math.min(...ok.map((p) => p.limitA!)), baseline: base.timeToSetpoint }
}

/**
 * Shot recovery in a match: while the wheel is being driven and has reached speed, a ball going through pulls it below
 * 85 % of the target for at least 0.1 s; recovery is the time until it is back within 10 %. Shorter dips are the
 * speed signal's noise (single 20 ms samples). This is the match version of spin-up time. Assumed, not yet checked
 * against video of the shots.
 */
export function shotRecoveries(match: Match, group: MotorGroup): number[] {
  const leaderKey = group.motors[0].velocity
  const spKey = group.spinUp?.setpoint
  const voltsKey = group.spinUp?.appliedVolts
  if (!leaderKey || !spKey || !voltsKey || !has(match, leaderKey) || !has(match, spKey) || !has(match, voltsKey)) return []
  const v = num(match, leaderKey)!
  const sp = num(match, spKey)!
  const applied = num(match, voltsKey)!
  const out: number[] = []
  let atSpeed = false
  let droppedAt = NaN
  for (let i = 0; i < v.t.length; i++) {
    const target = valueAt(sp, v.t[i])
    const driven = Math.abs(valueAt(applied, v.t[i])) > 1
    if (!driven || !(target > 10)) { atSpeed = false; droppedAt = NaN; continue }
    const ratio = Math.abs(v.v[i]) / target
    if (ratio >= REACHED) {
      if (Number.isFinite(droppedAt) && v.t[i] - droppedAt >= 0.1) out.push(v.t[i] - droppedAt)
      atSpeed = true
      droppedAt = NaN
    } else if (atSpeed && ratio < SHOT_DIP) {
      droppedAt = v.t[i]
      atSpeed = false
    }
  }
  return out
}
