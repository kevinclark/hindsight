/**
 * power/limit-not-applied — is each motor's current staying under its configured limit?
 *
 * Checks: for every motor group with limits in the robot profile, whether supply or stator current stayed above
 * 120 % of the configured limit for more than 0.2 s while enabled. Says whether the limit is switched off in code.
 * Why: CalGames 2026: the flywheel's 40 A supply limit is configured but disabled (DrumSubsystem.java:310), so
 * four motors pulled 78–94 A each during spin-up; the hood's 30 A stator limit read up to 66 A.
 * When it fires: if the limit is switched off, turn it on (and measure spin-up time before and after). If it is
 * on and still exceeded, check the config is applied to that motor.
 */
import { has, num, type Match } from '../../match/match.ts'
import { intervalsWhere, peakIn } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const OVER = 1.2
const MIN_SECONDS = 0.2

export const limitNotApplied: Rule = {
  id: 'power/limit-not-applied',
  title: 'Current limit not holding',
  fix: 'If the limit is switched off in code, switch it on and measure the mechanism before and after. If it is on, check the config reaches the motor (apply() return code, followers included).',
  incident: 'CalGames 2026: flywheel 78–94 A vs a disabled 40 A supply limit; hood 66 A vs 30 A stator (hindsight-research/design-detail.md §5a)',
  needs: (m: Match) => [m.profile.signals.enabled],
  run(m: Match): Finding[] {
    const out: Finding[] = []
    for (const group of m.profile.motorGroups) {
      const checks = [
        { kind: 'supply', limit: group.limits.supplyA, on: group.limits.supplyEnabled, key: (x: typeof group.motors[0]) => x.supplyCurrent },
        { kind: 'stator', limit: group.limits.statorA, on: group.limits.statorEnabled, key: (x: typeof group.motors[0]) => x.statorCurrent },
      ]
      for (const c of checks) {
        if (c.limit === undefined) continue
        let worst: { motor: string; key: string; seconds: number; peak: number; t: number } | null = null
        for (const motor of group.motors) {
          const key = c.key(motor)
          if (!key || !has(m, key)) continue
          const s = num(m, key)!
          const over = intervalsWhere(s, (a) => Math.abs(a) > c.limit! * OVER, m.enabled, m.logEnd).filter((iv) => iv.end - iv.start > MIN_SECONDS)
          if (over.length === 0) continue
          const seconds = over.reduce((sum, iv) => sum + iv.end - iv.start, 0)
          const peak = Math.max(...over.map((iv) => peakIn({ ...s, v: s.v.map(Math.abs) }, iv.start, iv.end).value))
          if (!worst || peak > worst.peak) worst = { motor: motor.name, key, seconds, peak, t: over[0].start }
        }
        if (!worst) continue
        out.push({
          rule: this.id,
          severity: 'error',
          title: `${group.name} ${c.kind} current reached ${worst.peak.toFixed(0)} A against a ${c.limit} A limit${c.on ? '' : ' that is switched off in code'}`,
          time: worst.t,
          evidence: {
            'worst motor': worst.motor,
            [`peak ${c.kind} current (A)`]: +worst.peak.toFixed(1),
            'configured limit (A)': c.limit,
            'limit enabled in code': c.on ? 'yes' : 'no',
            'seconds over 120 % of the limit (worst motor)': +worst.seconds.toFixed(1),
            'set in': group.limits.where,
          },
          plot: {
            from: worst.t - 2, to: worst.t + 4, unit: 'A',
            lines: group.motors.filter((x) => c.key(x) && has(m, c.key(x)!)).map((x) => ({ label: x.name, key: c.key(x)! })),
            threshold: { value: c.limit, label: `${c.limit} A limit` },
          },
        })
      }
    }
    return out
  },
}
