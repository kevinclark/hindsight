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

/**
 * Whether a limit runs, from the profile's Enable flag. A flag the profile sets is the answer. With no flag and no
 * number, the code doesn't set the limit, so Phoenix's default runs: true. With a number and no flag it is not known
 * (null): Phoenix 6 defaults the flag to true, but a hand-written profile may simply not say (limit-not-applied, LN-09).
 */
export function limitOn(l: CurrentLimits, kind: 'supply' | 'stator'): boolean | null {
  const [limitA, enabled] = kind === 'supply' ? [l.supplyA, l.supplyEnabled] : [l.statorA, l.statorEnabled]
  if (enabled !== undefined) return enabled
  return limitA === undefined ? true : null
}

/** How the wizard says it: "on", "switched off", or that the profile doesn't say. */
export const onOffWords = (on: boolean | null) => (on === null ? 'on or off: the profile doesn\'t say' : on ? 'on' : 'switched off')

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
  /** The configured value, and whether the code switches it on (null: the profile doesn't say, see limitOn). */
  limitA: number | null
  on: boolean | null
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
  const lower = {
    limitA: L.supplyLowerA ?? PHOENIX_DEFAULTS.supplyLowerA,
    seconds: L.supplyLowerSeconds ?? PHOENIX_DEFAULTS.supplyLowerSeconds,
    fromDefaults: L.supplyLowerA === undefined && L.supplyLowerSeconds === undefined,
  }
  // Limits not known: no note claims a default, and currents are shown with no limit to compare them with.
  const known = limitsKnown(L)
  const unknown = L.where.startsWith('not known') ? L.where : `not known: ${L.where}`
  // A group whose limits aren't known says nothing about on or off either.
  const supplyOn = known ? limitOn(L, 'supply') : null
  const statorOn = known ? limitOn(L, 'stator') : null
  const off = (kind: string, defaultA: number) => `switched off in code: this removes Phoenix's default ${defaultA} A ${kind} limit`
  const notSaid = (limitA: number | null, flag: string) => `${limitA} A if the code switches it on: the profile doesn't say. Phoenix switches it on unless the code sets ${flag} = false`
  const supply: LimitView = {
    kind: 'supply', limitA: supplyLimit, on: supplyOn,
    note: !known ? unknown : supplyOn === false ? off('supply', PHOENIX_DEFAULTS.supplyA) : supplyOn === null ? notSaid(supplyLimit, 'SupplyCurrentLimitEnable')
      : supplyLimit === null ? `not set: Phoenix's default ${PHOENIX_DEFAULTS.supplyA} A applies`
      : lowerLimitOff(L) ? `capped at ${supplyLimit} A; no lower limit (the code sets its time to 0)`
      : `capped at ${supplyLimit} A; after ${lower.seconds} s at the cap it drops to ${lower.limitA} A${lower.fromDefaults ? ' (Phoenix defaults: the code doesn\'t set these)' : ''}`,
    motors: g.motors.flatMap((m) => (m.supplyCurrent && has(match, m.supplyCurrent) ? [stats(match, m.name, num(match, m.supplyCurrent)!, known ? (supplyLimit ?? PHOENIX_DEFAULTS.supplyA) : Infinity)] : [])),
  }
  const stator: LimitView = {
    kind: 'stator', limitA: statorLimit, on: statorOn,
    note: !known ? unknown : statorOn === false ? off('stator', PHOENIX_DEFAULTS.statorA) : statorOn === null ? notSaid(statorLimit, 'StatorCurrentLimitEnable')
      : statorLimit === null ? `not set: Phoenix's default ${PHOENIX_DEFAULTS.statorA} A applies` : `capped at ${statorLimit} A`,
    motors: g.motors.flatMap((m) => (m.statorCurrent && has(match, m.statorCurrent) ? [stats(match, m.name, num(match, m.statorCurrent)!, known ? (statorLimit ?? PHOENIX_DEFAULTS.statorA) : Infinity)] : [])),
  }
  // What actually caps battery draw: each limit that runs (configured and on, or not set so Phoenix's default
  // applies; a limit switched off in code is gone). Supply can't exceed stator, so the stator limit caps it too. A
  // limit whose flag the profile doesn't give could be either, so the cap is known only when both readings agree.
  const caps = (on: boolean | null, limitA: number | null, defaultA: number) => (on === false ? [Infinity] : on === null ? [limitA!, Infinity] : [limitA ?? defaultA])
  const possible = caps(supplyOn, supplyLimit, PHOENIX_DEFAULTS.supplyA).flatMap((s) => caps(statorOn, statorLimit, PHOENIX_DEFAULTS.statorA).map((t) => Math.min(s, t)))
  const capPerMotorA = known && possible.every((c) => c === possible[0]) ? possible[0] : NaN
  // The limit the share is measured against: a configured one that may be on, the supply limit first.
  const mayRun = (l: LimitView) => l.on !== false && l.limitA !== null
  const limiting = mayRun(supply) ? supply : mayRun(stator) ? stator : supply
  const enabledSeconds = match.enabled.reduce((s, iv) => s + iv.end - iv.start, 0)
  const atLimit = limiting.motors.length ? Math.max(...limiting.motors.map((m) => m.secondsAtLimit)) : 0
  const shareAtLimit = enabledSeconds > 0 ? atLimit / enabledSeconds : 0
  const peak = Math.max(0, ...supply.motors.map((m) => m.peak))
  const verdict = !known ? 'limits not known' : supply.motors.length === 0 ? 'no current logged'
    : shareAtLimit >= 0.2 ? 'limit-bound'
    : peak < 0.7 * Math.min(...possible) ? 'unconstrained'
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
