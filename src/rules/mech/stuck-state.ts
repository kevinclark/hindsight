/**
 * Did the robot's state machine sit in one state while the drivers kept asking for something?
 *
 * Checks: the profile's state machine (stateMachine) staying in one state that isn't idle or waiting by design for
 * 20 s or more while enabled, with at least one driver request (a button) during it. What the state waits for is
 * learned from its normal exits in every loaded log: the profile sensor that flipped at least one loop before the
 * exit, in the 0.3 s before it. It is named only above a floor (5 exits or more, 80 % of them), with how often that
 * flip happens anyway (its base rate). A flip in the same loop as the exit doesn't count: it is a result of leaving.
 * Why: MTTD 2025 Friday p5: RIGHT_HANDOFF for the last 107 s of teleop, waiting for the arm's has-piece flag (it
 * came before 33 of 33 handoff exits); p8: SCORE_L4_RIGHT for the whole teleop. Q24 (26 s in the auto's score state,
 * 3 presses) fires; Q33 (23 s) stays quiet: its score request was held from auto, never pressed during the state.
 * Only presses count: a request held from before the state isn't a reaction to it (counting holds would add Q51's
 * 24.5 s READY_CORAL_INTAKE and two pit holds for one Q33). 20 s is assumed: Q51's 9 s carry-over stays under it.
 * The exits are learned across every loaded log of this robot, whatever build each ran.
 */
import { isTrue, rule, round } from '../rule.ts'
import { inside, lengthOf, type MatchView, type Window } from '../view.ts'
import { exitTrigger, stateStretches, type Trigger } from './state-exits.ts'

const STUCK_SECONDS = 20

export default rule({
  id: 'mech/stuck-state',
  title: 'State machine stuck in one state',
  severity: 'error',
  who: ['software', 'pit', 'drive'],
  meaning: 'The robot stayed in one state while the drivers pressed buttons, so it ignored them. The state was waiting for something: the evidence says what, and whether it came.',
  causes: [
    { id: 'piece', cause: 'The game piece was missing, dropped or jammed, so what the state waits for never happened', look: 'the match video at this time; the game piece path in the mechanism (the evidence names what the state waits for)' },
    { id: 'sensor', cause: 'A sensor fault: the sensor the state waits for didn\'t change although the piece was there', look: 'that sensor\'s wiring and mount; did it work earlier in this log? Its raw value (beam break, CANrange distance) if the code logs it' },
    { id: 'no-exit', cause: 'The code has no way out of this state for this situation (no timeout, no operator cancel)', look: 'the state machine code for this state: its exit conditions, and whether the operator can cancel it' },
  ],
  nextStep: 'Check what the state waits for (the evidence) on the robot: the game piece path and that sensor. Then give the state a way out in code: a timeout or an operator cancel.',
  incident: 'MTTD 2025 Friday p5 (RIGHT_HANDOFF, 107 s) and p8 (SCORE_L4_RIGHT, 135 s) (mttd-2025-context.md §1b, §2.9)',
  needsProfile: true,

  check(match) {
    const machine = match.profile.stateMachine
    if (!machine) return match.couldNotCheck('the robot profile names no state machine')
    const waiting = new Set([...machine.idle, ...machine.waitsOnPurpose])
    const requests = machine.requests.filter((r) => match.has(r.key)).map((r) => ({ name: r.name, on: match.signal(r.key) }))
    if (requests.length === 0) return match.couldNotCheck(`none of the driver request keys is in this log (${machine.requests.map((r) => r.key).join(', ')})`)
    return stateStretches(match, machine.state).flatMap((s) => {
      if (waiting.has(s.state)) return []
      const during: Window = match.enabled.flatMap((iv) => (iv.end > s.start && iv.start < s.end ? [{ start: Math.max(iv.start, s.start), end: Math.min(iv.end, s.end) }] : []))
      const seconds = lengthOf(during)
      const presses = requests.map((r) => ({ name: r.name, n: r.on.turnsOn(during).length })).filter((r) => r.n > 0)
      if (seconds < STUCK_SECONDS || presses.length === 0) return []
      const trigger = exitTrigger(match, s.state)
      const came = trigger.named ? cameDuring(match, trigger, during) : null
      return [{
        message: `${machine.name} stayed in ${s.state} for ${seconds.toFixed(0)} s while enabled, from ${match.when(during[0].start)}, through ${presses.reduce((a, r) => a + r.n, 0)} driver requests`
          + (trigger.named ? `; it usually leaves when ${trigger.words}, which ${cameText(match, came, during)}` : ''),
        at: during[0].start,
        about: s.state,
        likely: came !== null && came !== undefined ? ['no-exit'] : undefined,
        measured: [{ label: `in ${s.state} while enabled`, value: round(seconds, 1), unit: 's', threshold: STUCK_SECONDS }],
        evidence: {
          state: s.state,
          'seconds in it while enabled': round(seconds, 1),
          'driver requests during it': presses.map((r) => `${r.name} ×${r.n}`).join(', '),
          'what it usually waits for (learned from its exits)': trigger.text,
          ...(trigger.named ? { [`${trigger.words}, during this stretch`]: cameText(match, came, during) } : {}),
        },
      }]
    })
  },
})

/** The trigger during the stretch, in words. */
function cameText(match: MatchView, came: number | null, during: Window): string {
  return came === null ? 'never happened' : came === during[0].start ? 'was already so when the stretch began, but it stayed' : `happened at ${match.when(came)}, but it stayed`
}

/** When the learned trigger happened during the stretch (null if it never did). */
function cameDuring(match: MatchView, trigger: Trigger, during: Window): number | null {
  const s = match.signal(trigger.key)
  const want = trigger.to
  // Already in the wanted value when the stretch began counts as "came" at its start.
  if (isTrue(s.at(during[0].start)) === want) return during[0].start
  for (let i = 0; i < s.series.t.length; i++) if (inside(during, s.series.t[i]) && isTrue(s.series.v[i]) === want) return s.series.t[i]
  return null
}
