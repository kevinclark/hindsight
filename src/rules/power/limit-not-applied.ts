/**
 * Is each motor's current staying under its configured limit?
 *
 * Checks: for each motor group with limits in the robot profile, supply and stator current above 120 % of the limit
 * for more than 0.2 s while enabled. (Shorter bursts are the limiter catching up: ≤ 0.21 s at CalGames.) Says when the
 * limit is switched off in code: amber when the log ran the profile's commit, or another commit whose current-limit
 * lines a robot-code folder shows are the same (src/code/limit-lines.ts); red otherwise, as other code may differ. Only
 * the lines in the files `where` names are compared: a limit set through a name defined in another file isn't followed.
 * The share of enabled time over 110 % of the limit is evidence only: at CalGames it is made of
 * 154–233 bursts per motor per match with a median of 0.02 s (one 50 Hz sample) and a longest of 0.26 s, the limiter
 * catching up at each acceleration, so on its own it does not mean the limit is failing.
 * Why: CalGames 2026: the flywheel's 40 A supply limit is configured but switched off (DrumSubsystem.java:310), so
 * four motors pulled 78–94 A each during spin-up.
 */
import { amps, beyond, isFalse, rule, round, totalSeconds, type Problem } from '../rule.ts'
import type { LimitLines } from '../../code/limit-lines.ts'
import { lengthOf, MissingSignal, type GroupView, type MatchView, type MotorView, type Window } from '../view.ts'

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

    // The profile copies the limits from one commit of the robot code. A log that ran another commit counts as that
    // code when the robot-code folder shows its current-limit lines are the same; otherwise say it ran other code.
    const ranPin = match.ranPinnedCommit()
    const compared = ranPin ? null : match.limitLinesVsProfile(group)
    const sameCode = ranPin || compared?.verdict === 'same'
    const { asOf, linesWords } = codeWords(match, ranPin, compared)

    const problems: Problem[] = []
    for (const { kind, limit, isOn } of kinds) {
      if (limit === undefined) continue
      const worst = worstOverLimit(group, kind, limit, match)
      if (worst === null) continue
      const share = shareOverLimit(group, kind, limit, match)

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
        message: `${group.name} ${kind} current reached ${amps(worst.peak)} against a ${limit} A limit${switchedOff}${asOf}`,
        at: worst.start,
        about: `${group.name} ${kind}`,
        evidence: {
          'worst motor': worst.motor,
          [`peak ${kind} current (A)`]: round(worst.peak, 1),
          'seconds over 120 % of the limit (worst motor)': round(worst.secondsOver, 1),
          'share of enabled time over 110 % of the limit (worst motor) (%)': share ? round(share.percent, 1) : undefined,
          'configured limit (A)': limit,
          'limit switched on in code': `${isOn ? 'yes' : 'no'}${asOf}`,
          'set in': group.limits.where,
          'current-limit lines vs the profile\'s commit': linesWords,
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

/** How the code this log ran compares with the profile's commit, for the message and the evidence. */
function codeWords(match: MatchView, ranPin: boolean, compared: LimitLines | null) {
  const pin = match.profile.code
  const ran = match.build.sha.slice(0, 7) || 'unknown code'
  if (ranPin) return { asOf: '', linesWords: undefined }
  if (compared?.verdict === 'same') {
    return {
      asOf: ` (same current-limit lines as ${pin.branch} ${pin.sha}; this log ran ${ran})`,
      linesWords: `the same as ${pin.sha} in ${compared.files.join(', ')} (read from the robot code)`,
    }
  }
  let linesWords: string | undefined
  if (compared?.verdict === 'different') linesWords = `different from ${pin.sha}: ${compared.lines.join('; ')}`
  if (compared?.verdict === 'unknown') linesWords = `not compared: ${compared.why}`
  return { asOf: ` (as of ${pin.branch} ${pin.sha}; this log ran ${ran})`, linesWords }
}

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
