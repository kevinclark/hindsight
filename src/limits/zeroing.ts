/**
 * Hard-stop zeroing check (no robot run needed): from normal match logs, how much current the mechanism draws while
 * pushed against its stop to zero, and how far the detection threshold sits below the stator limit.
 *
 * A current zero drives the mechanism into its hard stop and calls it zeroed when the current passes a threshold. If
 * the threshold equals the stator limit, the current only gets there when the limiter overshoots, so the zero
 * depends on overshoot (CalGames: the hood's 30 A threshold = its 30 A stator limit).
 */

import { has, num, values, type Match } from '../match/match.ts'
import { valueAt } from '../match/series.ts'

export interface ZeroingCheck {
  mechanism: string
  thresholdA: number
  statorLimitA: number
  where: string
  /** Each completed zero in the log: when, the peak stator current in the half second before it, and how long the
   * current was at or above the threshold (a zero that trips on a 40 ms spike is tripping on overshoot). */
  zeros: { at: number; peakA: number; secondsAtThreshold: number }[]
  /** The threshold is at (or above) the stator limit: the zero only trips on overshoot. */
  thresholdAtLimit: boolean
  /** A threshold with margin: 70 % of the stator limit, rounded down to 5 A. */
  suggestedThresholdA: number
}

export function zeroingChecks(match: Match): ZeroingCheck[] {
  const out: ZeroingCheck[] = []
  const consoleKey = match.profile.signals.console
  for (const z of match.profile.zeroing) {
    if (!z.zeroCurrent) continue
    const zeros: ZeroingCheck['zeros'] = []
    if (has(match, consoleKey) && has(match, z.zeroCurrent.statorCurrent)) {
      const lines = values<string>(match, consoleKey)!
      const current = num(match, z.zeroCurrent.statorCurrent)!
      lines.v.forEach((line, i) => {
        // Only zeros that ran while enabled are current zeros (a zero at boot just sets the encoder).
        const at = lines.t[i]
        if (!z.doneMessage.test(line) || !match.enabled.some((iv) => at >= iv.start && at <= iv.end + 0.1)) return
        // Hold-last over the half second before the zero, in 5 ms steps.
        let peakA = 0, secondsAtThreshold = 0
        for (let t = at - 0.5; t <= at; t += 0.005) {
          const a = Math.abs(valueAt(current, t))
          if (a > peakA) peakA = a
          if (a >= z.zeroCurrent!.thresholdA) secondsAtThreshold += 0.005
        }
        zeros.push({ at, peakA, secondsAtThreshold })
      })
    }
    const { thresholdA, statorLimitA, where } = z.zeroCurrent
    out.push({
      mechanism: z.mechanism, thresholdA, statorLimitA, where, zeros,
      thresholdAtLimit: thresholdA >= statorLimitA,
      suggestedThresholdA: Math.floor((0.7 * statorLimitA) / 5) * 5,
    })
  }
  return out
}
