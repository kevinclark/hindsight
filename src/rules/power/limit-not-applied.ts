/**
 * power/limit-not-applied — is each motor's current staying under its configured limit?
 *
 * Checks: for every motor group with limits in the robot profile, whether supply or stator current stayed above
 * 120 % of the configured limit for more than 0.2 s while enabled. Says whether the limit is switched off in code.
 * Why: CalGames 2026: the flywheel's 40 A supply limit is configured but disabled (DrumSubsystem.java:310), so
 * four motors pulled 78–94 A each during spin-up.
 * When it fires: if the limit is switched off, turn it on (and measure spin-up time before and after). If it is
 * on and still exceeded, check the config is applied to that motor.
 */
import { has, num, type Match } from '../../match/match.ts'
import { intervalsWhere, peakAbsIn, withMissing } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const OVER = 1.2
const MIN_SECONDS = 0.2

export const limitNotApplied: Rule = {
  id: 'power/limit-not-applied',
  title: 'Current limit not holding',
  audience: ['software'],
  fix: 'If the limit is switched off in code, switch it on and measure the mechanism before and after. If it is on, check the config reaches the motor (apply() return code, followers included).',
  incident: 'CalGames 2026: flywheel 78–94 A vs a disabled 40 A supply limit (hindsight-research/design-detail.md §5a)',
  needs: (m: Match) => [m.profile.signals.enabled],
  run(m: Match) {
    const out: Finding[] = []
    const missing: string[] = []
    let total = 0
    for (const g of m.profile.motorGroups) {
      for (const kind of ['supply', 'stator'] as const) {
        const limit = kind === 'supply' ? g.limits.supplyA : g.limits.statorA
        if (limit === undefined) continue
        let worst: { motor: string; seconds: number; peak: number; t: number } | null = null
        for (const motor of g.motors) {
          const key = kind === 'supply' ? motor.supplyCurrent : motor.statorCurrent
          if (!key) continue
          total++
          if (!has(m, key)) { missing.push(key); continue }
          const s = num(m, key)!
          const over = intervalsWhere(s, (a) => Math.abs(a) > limit * OVER, m.enabled, m.logEnd).filter((iv) => iv.end - iv.start > MIN_SECONDS)
          if (over.length === 0) continue
          const peak = Math.max(...over.map((iv) => peakAbsIn(s, iv.start, iv.end).value))
          const seconds = over.reduce((sum, iv) => sum + iv.end - iv.start, 0)
          if (!worst || peak > worst.peak) worst = { motor: motor.name, seconds, peak, t: over[0].start }
        }
        if (!worst) continue
        const on = kind === 'supply' ? g.limits.supplyEnabled : g.limits.statorEnabled
        // The profile copies the limits from one commit; say so when this log ran different code.
        const asOf = m.build.sha.startsWith(m.profile.configSha) ? '' : ` (as of ${m.profile.configSha}; this log ran ${m.build.sha.slice(0, 7) || 'unknown code'})`
        out.push({
          rule: this.id,
          severity: 'error',
          title: `${g.name} ${kind} current reached ${worst.peak.toFixed(0)} A against a ${limit} A limit${on ? '' : ' that is switched off in code'}${asOf}`,
          time: worst.t,
          evidence: {
            'worst motor': worst.motor,
            [`peak ${kind} current (A)`]: +worst.peak.toFixed(1),
            'configured limit (A)': limit,
            'limit enabled in code': `${on ? 'yes' : 'no'}${asOf}`,
            'seconds over 120 % of the limit (worst motor)': +worst.seconds.toFixed(1),
            'set in': g.limits.where,
          },
          plot: {
            from: worst.t - 2, to: worst.t + 4, unit: 'A', threshold: { value: limit, label: `${limit} A limit` },
            lines: g.motors.map((x) => ({ label: x.name, key: (kind === 'supply' ? x.supplyCurrent : x.statorCurrent) ?? '' })).filter((l) => has(m, l.key)),
          },
        })
      }
    }
    return withMissing(out, missing, total)
  },
}
