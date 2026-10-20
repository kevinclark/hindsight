/**
 * Is each motor's current staying under its configured limit?
 *
 * Checks: for each motor group with limits in the robot profile, supply and stator current above 120 % of the limit
 * for more than 0.2 s while enabled. (Shorter bursts are the limiter catching up: ≤ 0.21 s at CalGames.) For a limit
 * that is switched on, also: the worst motor over 110 % of the limit for more than SHARE_OVER_LIMIT of the enabled
 * time, even with no single run that long: a limit that holds is not exceeded again and again. Says when the limit is
 * switched off in code.
 * Why: CalGames 2026: the flywheel's 40 A supply limit is configured but switched off (DrumSubsystem.java:310), so
 * four motors pulled 78–94 A each during spin-up.
 */
import { amps, beyond, isFalse, rule, round, totalSeconds, type Problem } from '../rule.ts'
import { lengthOf, MissingSignal, type GroupView, type MatchView, type MotorView, type Window } from '../view.ts'

// The share of enabled time (%) over 110 % of an enabled limit that tells a limit that holds from one that doesn't.
// Assumed, from 8 CalGames 2026 logs of one robot (8 qualification, practice and test logs, 150–160 s enabled each),
// the worst motor of each group with a limit switched on: groups that hold sit at 0–0.9 % (drive stator, steer,
// indexer, kicker, hood, flywheel stator, intake pivot stator); groups that don't sit at 2.5–8.5 % (drive supply
// 2.5–3.8 %, peaks 61–67 A on a 40 A limit; intake roller stator 2.6–8.5 %). Nothing was measured between 0.9 and
// 2.5 %; 1.5 % is the middle of that gap (geometric mean). Other robots are untested.
const SHARE_OVER_LIMIT = 1.5

export default rule({
  id: 'power/limit-not-applied',
  title: 'Current limit not holding',
  severity: 'error',
  who: ['software'],
  meaning: 'The motors drew far more current than their configured limit: the limit is switched off, or it is on and not reaching the motors. Heavy current like this is a common reason for brownouts.',
  causes: [
    { id: 'limit-off', cause: 'The limit is configured but switched off in code (the enable flag is false)', look: 'the code file in this finding\'s "set in" evidence: the current-limit enable setting for this group' },
    { id: 'not-saved', cause: 'The configuration never reached the motor (the apply call failed, or a follower was missed, or the controller was replaced)', look: 'the return code of the config apply call in the code, for the leader and each follower; the vendor tool\'s view of the motor\'s limits' },
    { id: 'default-limit', cause: 'The motor is running the controller\'s default limits (Phoenix 6: 70 A supply, 120 A stator), not the one you chose', look: 'whether the code sets this limit at all, and whether supply and stator limits were mixed up' },
    { id: 'wrong-value', cause: 'The limit is set too high for what the mechanism needs', look: 'the limit value in the code against the Limits tab: what current the mechanism actually needs' },
  ],
  nextStep: 'If the limit is switched off in code, switch it on and measure the mechanism before and after. If it is on, check the config reaches every motor.',
  incident: 'CalGames 2026: flywheel 78–94 A vs a disabled 40 A supply limit (hindsight-research/design-detail.md §5a)',
  forEach: 'motorGroup',

  check(group, match) {
    if (group.limits.supplyA === undefined && group.limits.statorA === undefined) {
      return match.couldNotCheck(`the robot profile has no current limits for ${group.name} (${group.limits.where})`)
    }
    const kinds = [
      { kind: 'supply', limit: group.limits.supplyA, isOn: group.limits.supplyEnabled },
      { kind: 'stator', limit: group.limits.statorA, isOn: group.limits.statorEnabled },
    ] as const

    // The profile copies the limits from one commit of the robot code; say so when this log ran other code.
    const pin = match.profile.code
    const sameCode = match.build.sha.startsWith(pin.sha)
    const asOf = sameCode ? '' : ` (as of ${pin.branch} ${pin.sha}; this log ran ${match.build.sha.slice(0, 7) || 'unknown code'})`

    const problems: Problem[] = []
    for (const { kind, limit, isOn } of kinds) {
      if (limit === undefined) continue
      const run = worstOverLimit(group, kind, limit, match)
      const share = shareOverLimit(group, kind, limit, match)
      // A switched-off limit is explained by the run over 120 %; a switched-on one also fails by being over, often.
      const oftenOver = isOn && share !== null && share.percent > SHARE_OVER_LIMIT
      const worst = run ?? (oftenOver ? share : null)
      if (worst === null) continue

      // Switched off in code: that is the cause. Switched on (in the code the profile came from): the config likely
      // didn't reach the motor.
      let likely: string[] | undefined
      let nextStep: string | undefined
      const ruledOut: Record<string, string> = {}
      if (!isOn) {
        likely = ['limit-off']
        nextStep = `The ${kind} limit is switched off in ${group.limits.where}. On purpose? Mark it as a known issue. If not, switch it on and measure the mechanism before and after.`
      } else if (sameCode) {
        likely = ['not-saved', 'default-limit']
        ruledOut['limit-off'] = 'the limit is switched on in the code'
      }
      const switchedOff = isOn ? '' : ' that is switched off in code (deliberate?)'
      // Switched off in the code this log ran may be deliberate (the mechanism may not need a limit): a warning. When the
      // log ran other code than the profile's, "off" is not known for this log, so it stays an error.
      const offInThisCode = !isOn && sameCode
      problems.push({
        severity: offInThisCode ? 'warning' : undefined,
        likely,
        ruledOut,
        nextStep,
        message: run
          ? `${group.name} ${kind} current reached ${amps(worst.peak)} against a ${limit} A limit${switchedOff}${asOf}`
          : `${group.name} ${kind} current was over 110 % of its ${limit} A limit for ${round(share?.percent ?? 0, 1)} % of the enabled time (peak ${amps(worst.peak)})${asOf}`,
        at: worst.start,
        about: `${group.name} ${kind}`,
        evidence: {
          'worst motor': worst.motor,
          [`peak ${kind} current (A)`]: round(worst.peak, 1),
          'seconds over 120 % of the limit (worst motor)': run ? round(run.secondsOver, 1) : undefined,
          'share of enabled time over 110 % of the limit (worst motor) (%)': share ? round(share.percent, 1) : undefined,
          'configured limit (A)': limit,
          'limit switched on in code': `${isOn ? 'yes' : 'no'}${asOf}`,
          'set in': group.limits.where,
        },
        measured: [{ label: `peak ${kind} current`, value: round(worst.peak, 0), unit: 'A', threshold: round(limit * 1.2, 0) }],
        plot: {
          signals: group.motors.map((m) => currentOf(m, kind)), unit: 'A',
          from: worst.start - 2, to: worst.start + 4, line: { value: limit, label: `${limit} A limit` },
        },
      })
    }
    return problems
  },
})

/**
 * The time while enabled that the motor was on CAN. A controller that dropped off CAN logs no more currents, so the
 * last one stays "held" for the rest of the log; that is not the motor drawing it. (No Connected flag logged: all of
 * the enabled time.)
 */
function enabledAndConnected(motor: MotorView, match: MatchView): Window {
  let offCan
  try {
    offCan = motor.connected().episodes(isFalse)
  } catch (error) {
    if (error instanceof MissingSignal) return match.enabled
    throw error
  }
  return match.enabled.flatMap((enabled) => {
    let pieces = [{ start: enabled.start, end: enabled.end }]
    for (const off of offCan) {
      pieces = pieces.flatMap((p) => [
        { start: p.start, end: Math.min(p.end, off.start) },
        { start: Math.max(p.start, off.end), end: p.end },
      ]).filter((p) => p.end > p.start)
    }
    return pieces
  })
}

/** The supply or stator current of a motor. */
function currentOf(motor: MotorView, kind: 'supply' | 'stator') {
  return kind === 'supply' ? motor.supply() : motor.stator()
}

/** The motor that spent the largest share of the enabled time over 110 % of the limit (null if none was over). */
function shareOverLimit(group: GroupView, kind: 'supply' | 'stator', limit: number, match: MatchView) {
  const enabledSeconds = lengthOf(match.enabled)
  let worst = { motor: '', percent: 0, peak: 0, start: 0 }
  for (const motor of group.motors) {
    const over = currentOf(motor, kind).episodes(beyond(limit * 1.1), { during: enabledAndConnected(motor, match) })
    const percent = (100 * totalSeconds(over)) / enabledSeconds
    if (over.length === 0 || percent <= worst.percent) continue
    const highest = over.reduce((a, b) => (b.peak > a.peak ? b : a))
    worst = { motor: motor.name, percent, peak: highest.peak, start: highest.start }
  }
  return worst.motor === '' || enabledSeconds === 0 ? null : worst
}

/** The motor whose current went highest while over 120 % of the limit for more than 0.2 s (null if none did). */
function worstOverLimit(group: GroupView, kind: 'supply' | 'stator', limit: number, match: MatchView) {
  let worst = { motor: '', peak: 0, start: 0, secondsOver: 0 }
  for (const motor of group.motors) {
    const over = currentOf(motor, kind).episodes(beyond(limit * 1.2), { during: enabledAndConnected(motor, match), longerThan: 0.2 })
    for (const e of over) {
      if (e.peak <= worst.peak) continue
      worst = { motor: motor.name, peak: e.peak, start: e.start, secondsOver: totalSeconds(over) }
    }
  }
  return worst.motor === '' ? null : worst
}
