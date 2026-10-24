/**
 * The Limits tab: for each motor group, the current limits configured in code against what the log shows.
 *
 * Stator current is what flows through the motor windings (torque, heat). Supply current is what the motor draws
 * from the battery. Supply ≈ stator × duty cycle, so supply can't exceed stator. Background:
 * 8033/robot/patches/2026-10-19-power-safety.md (from CTRE's Phoenix 6 docs).
 *
 * "Over the limit" means more than 5 A over it, as in the reference script (scripts/limits-reference.ts). Bursts of
 * 0.2 s or less are the limiter catching up (≤ 0.21 s at the 2026 offseason event), not a limit that doesn't hold.
 */

import { has, num, type Match } from '../match/match.ts'
import type { CurrentLimits, MotorGroup } from '../profiles/types.ts'
import { percentile, type Interval, type NumberSeries } from '../match/series.ts'

/** Phoenix 6 defaults for a TalonFX, used when the code switches a limit off or doesn't set it. */
export const PHOENIX_DEFAULTS = { supplyA: 70, statorA: 120, supplyLowerA: 40, supplyLowerSeconds: 1.0 }

/**
 * Does the profile say anything about this group's limits? One with no number and no on/off (a builder draft the code
 * and no snapshot could fill, or a profile that didn't read the code) is "not known", never Phoenix's defaults.
 */
export const limitsKnown = (l: CurrentLimits) => [l.supplyA, l.statorA, l.supplyEnabled, l.statorEnabled].some((x) => x !== undefined)

/** Phoenix 6 ignores SupplyCurrentLowerLimit when SupplyCurrentLowerTime is 0 (CurrentLimitsConfigs, 26.x): the supply limit holds. */
export const lowerLimitOff = (l: CurrentLimits) => l.supplyLowerSeconds === 0

export const OVER_MARGIN_A = 5
export const CATCH_UP_SECONDS = 0.2
/** Within this fraction of the limit counts as "at the limit". */
export const AT_LIMIT = 0.9

export interface CurrentStats {
  motor: string
  peak: number
  p99: number
  /** Seconds more than 5 A over the limit, and the longest single burst. */
  secondsOver: number
  longestOver: number
  /** Seconds over in bursts longer than 0.2 s (the limit not holding, or switched off). */
  secondsOverSustained: number
  /** Seconds at 90 % of the limit or more. */
  secondsAtLimit: number
  /** Longest single stretch at the limit (the lower limit kicks in after supplyLowerSeconds). */
  longestAtLimit: number
}

export interface LimitView {
  kind: 'supply' | 'stator'
  /** The configured value, and whether the code switches it on. */
  limitA: number | null
  on: boolean
  /** What actually limits the motor: the configured value when on; nothing (or the stator limit) when off. */
  note: string
  motors: CurrentStats[]
}

export interface GroupLimits {
  group: string
  where: string
  supplyLines: string | null
  motorCount: number
  supply: LimitView
  stator: LimitView
  lower: { limitA: number; seconds: number; fromDefaults: boolean }
  /** Highest current per motor the configuration allows (supply limit if on, else the stator limit if on); NaN when its limits aren't known. */
  capPerMotorA: number
  /** Share of enabled time the group spends at its limiting value. */
  shareAtLimit: number
  verdict: 'limit-bound' | 'reaches the limit' | 'unconstrained' | 'no current logged' | 'limits not known'
}

export function limitsReport(match: Match): GroupLimits[] {
  return match.profile.motorGroups.map((g) => groupLimits(match, g))
}

function groupLimits(match: Match, g: MotorGroup): GroupLimits {
  const L = g.limits
  const supplyLimit = L.supplyA ?? null
  const statorLimit = L.statorA ?? null
  const supplyOn = !!L.supplyEnabled && supplyLimit !== null
  const statorOn = !!L.statorEnabled && statorLimit !== null
  const lower = {
    limitA: L.supplyLowerA ?? PHOENIX_DEFAULTS.supplyLowerA,
    seconds: L.supplyLowerSeconds ?? PHOENIX_DEFAULTS.supplyLowerSeconds,
    fromDefaults: L.supplyLowerA === undefined && L.supplyLowerSeconds === undefined,
  }
  // Limits not known: no note claims a default, and currents are shown with no limit to compare them with.
  const known = limitsKnown(L)
  const unknown = L.where.startsWith('not known') ? L.where : `not known: ${L.where}`
  const supply: LimitView = {
    kind: 'supply', limitA: supplyLimit, on: supplyOn,
    note: !known ? unknown : supplyOn && lowerLimitOff(L) ? `capped at ${supplyLimit} A; no lower limit (the code sets its time to 0)`
      : supplyOn ? `capped at ${supplyLimit} A; after ${lower.seconds} s at the cap it drops to ${lower.limitA} A${lower.fromDefaults ? ' (Phoenix defaults: the code doesn\'t set these)' : ''}`
      : supplyLimit !== null ? `switched off in code: this removes Phoenix's default ${PHOENIX_DEFAULTS.supplyA} A supply limit` : `not set: Phoenix's default ${PHOENIX_DEFAULTS.supplyA} A applies`,
    motors: g.motors.flatMap((m) => (m.supplyCurrent && has(match, m.supplyCurrent) ? [stats(match, m.name, num(match, m.supplyCurrent)!, known ? (supplyLimit ?? PHOENIX_DEFAULTS.supplyA) : Infinity)] : [])),
  }
  const stator: LimitView = {
    kind: 'stator', limitA: statorLimit, on: statorOn,
    note: !known ? unknown : statorOn ? `capped at ${statorLimit} A` : statorLimit !== null ? `switched off in code: this removes Phoenix's default ${PHOENIX_DEFAULTS.statorA} A stator limit` : `not set: Phoenix's default ${PHOENIX_DEFAULTS.statorA} A applies`,
    motors: g.motors.flatMap((m) => (m.statorCurrent && has(match, m.statorCurrent) ? [stats(match, m.name, num(match, m.statorCurrent)!, known ? (statorLimit ?? PHOENIX_DEFAULTS.statorA) : Infinity)] : [])),
  }
  // What actually caps battery draw: each limit that exists (configured and on, or not set so Phoenix's default
  // applies; a limit switched off in code is gone). Supply can't exceed stator, so the stator limit caps it too.
  const supplyCap = supplyOn ? supplyLimit! : supplyLimit === null ? PHOENIX_DEFAULTS.supplyA : Infinity
  const statorCap = statorOn ? statorLimit! : statorLimit === null ? PHOENIX_DEFAULTS.statorA : Infinity
  const capPerMotorA = known ? Math.min(supplyCap, statorCap) : NaN
  const limiting = supplyOn ? supply : statorOn ? stator : supply
  const enabledSeconds = match.enabled.reduce((s, iv) => s + iv.end - iv.start, 0)
  const atLimit = limiting.motors.length ? Math.max(...limiting.motors.map((m) => m.secondsAtLimit)) : 0
  const shareAtLimit = enabledSeconds > 0 ? atLimit / enabledSeconds : 0
  const peak = Math.max(0, ...supply.motors.map((m) => m.peak))
  const verdict = !known ? 'limits not known' : supply.motors.length === 0 ? 'no current logged'
    : shareAtLimit >= 0.2 ? 'limit-bound'
    : peak < 0.7 * capPerMotorA ? 'unconstrained'
    : 'reaches the limit'
  return { group: g.name, where: L.where, supplyLines: L.supplyLines ?? null, motorCount: g.motors.length, supply, stator, lower, capPerMotorA, shareAtLimit, verdict }
}

/** Current statistics for one motor against one limit, over enabled time (hold-last durations). */
export function stats(match: Match, motor: string, s: NumberSeries, limitA: number): CurrentStats {
  const enabled = match.enabled
  const over = runs(s, (a) => Math.abs(a) > limitA + OVER_MARGIN_A, enabled, match.logEnd)
  const atLimit = runs(s, (a) => Math.abs(a) >= AT_LIMIT * limitA, enabled, match.logEnd)
  const values: number[] = []
  for (let i = 0; i < s.t.length; i++) if (enabled.some((iv) => s.t[i] >= iv.start && s.t[i] < iv.end)) values.push(Math.abs(s.v[i]))
  const len = (iv: Interval) => iv.end - iv.start
  return {
    motor,
    peak: values.reduce((m, v) => Math.max(m, v), 0),
    p99: values.length ? percentile(values, 99) : NaN,
    secondsOver: over.reduce((sum, iv) => sum + len(iv), 0),
    longestOver: over.reduce((m, iv) => Math.max(m, len(iv)), 0),
    secondsOverSustained: over.filter((iv) => len(iv) > CATCH_UP_SECONDS).reduce((sum, iv) => sum + len(iv), 0),
    secondsAtLimit: atLimit.reduce((sum, iv) => sum + len(iv), 0),
    longestAtLimit: atLimit.reduce((m, iv) => Math.max(m, len(iv)), 0),
  }
}

/** Stretches where a signal passes a test (hold-last), clipped to the windows, touching stretches joined. */
function runs(s: NumberSeries, test: (v: number) => boolean, within: Interval[], logEnd: number): Interval[] {
  const out: Interval[] = []
  for (let i = 0; i < s.t.length; i++) {
    if (!test(s.v[i])) continue
    const end = i + 1 < s.t.length ? s.t[i + 1] : logEnd
    for (const w of within) {
      const a = Math.max(s.t[i], w.start), b = Math.min(end, w.end)
      if (b > a) {
        const last = out[out.length - 1]
        if (last && a <= last.end) last.end = Math.max(last.end, b)
        else out.push({ start: a, end: b })
      }
    }
  }
  return out
}
