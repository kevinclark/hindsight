/**
 * Is each motor's current staying under its configured limit?
 *
 * Checks: for each motor group with limits in the robot profile, supply and stator current above 120 % of the limit
 * for more than 0.2 s while enabled. (Shorter bursts are the limiter catching up: ≤ 0.21 s at CalGames.) Says when
 * the limit is switched off in code.
 * Why: CalGames 2026: the flywheel's 40 A supply limit is configured but switched off (DrumSubsystem.java:310), so
 * four motors pulled 78–94 A each during spin-up.
 */
import { amps, beyond, rule, round, type Problem } from '../rule.ts'

export default rule({
  id: 'power/limit-not-applied',
  title: 'Current limit not holding',
  severity: 'error',
  who: ['software'],
  fix: 'If the limit is switched off in code, switch it on and measure the mechanism before and after. If it is on, check the config reaches the motor (apply() return code, followers included).',
  incident: 'CalGames 2026: flywheel 78–94 A vs a disabled 40 A supply limit (hindsight-research/design-detail.md §5a)',
  forEach: 'motorGroup',

  check(group, match) {
    const problems: Problem[] = []
    const kinds = [
      { kind: 'supply', limit: group.limits.supplyA, isOn: group.limits.supplyEnabled },
      { kind: 'stator', limit: group.limits.statorA, isOn: group.limits.statorEnabled },
    ]
    for (const { kind, limit, isOn } of kinds) {
      if (limit === undefined) continue
      // Find the motor whose current went highest while over the limit for more than 0.2 s.
      let worst = { motor: '', peak: 0, start: 0, secondsOver: 0 }
      for (const motor of group.motors) {
        const current = kind === 'supply' ? motor.supply() : motor.stator()
        const over = current.episodes(beyond(limit * 1.2), { during: match.enabled, longerThan: 0.2 })
        for (const e of over) {
          if (e.peak > worst.peak) {
            const secondsOver = over.reduce((sum, x) => sum + x.seconds, 0)
            worst = { motor: motor.name, peak: e.peak, start: e.start, secondsOver }
          }
        }
      }
      if (worst.motor === '') continue
      // The profile copies the limits from one commit of the robot code; say so when this log ran other code.
      const sameCode = match.build.sha.startsWith(match.profile.configSha)
      const asOf = sameCode ? '' : ` (as of ${match.profile.configSha}; this log ran ${match.build.sha.slice(0, 7) || 'unknown code'})`
      problems.push({
        message: `${group.name} ${kind} current reached ${amps(worst.peak)} against a ${limit} A limit${isOn ? '' : ' that is switched off in code'}${asOf}`,
        at: worst.start,
        about: `${group.name} ${kind}`,
        evidence: {
          'worst motor': worst.motor,
          [`peak ${kind} current (A)`]: round(worst.peak, 1),
          'seconds over 120 % of the limit (worst motor)': round(worst.secondsOver, 1),
          'configured limit (A)': limit,
          'limit switched on in code': `${isOn ? 'yes' : 'no'}${asOf}`,
          'set in': group.limits.where,
        },
        plot: group.motors.map((m) => (kind === 'supply' ? m.supply() : m.stator())), plotUnit: 'A',
        plotFrom: worst.start - 2, plotTo: worst.start + 4, plotLine: { value: limit, label: `${limit} A limit` },
      })
    }
    return problems
  },
})
