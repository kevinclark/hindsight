/**
 * Would a motor's own breaker on the power distribution board have tripped, by its maker's trip curve?
 *
 * Checks: each motor sits alone on one PDP breaker (rule R621). That breaker's datasheet gives a band, the earliest an
 * in-spec breaker may trip (fast edge) and the latest (slow edge); the motor's supply current heats each edge as that
 * edge's curve says (src/power/breakers.ts). Fires, one finding per motor, when the fast edge reaches 100 %: a breaker at
 * the fast end of its band would have tripped. Which breaker a motor is on comes from the robot's power map
 * (src/power/power-map.ts); with no map the fastest legal 40 A breaker (Snap Action) is assumed: it trips soonest from
 * about 140 % of its rating up (3 to 15 times sooner than REV at 200 %), but below about 133 % its fast edge never trips
 * where REV's and CTRE's do. Amber only: no PDP-breaker trip is in the logs we have, so the line rests on the datasheet alone.
 * The PDP 2.0's other channels (radio, roboRIO) carry no measured current, so this rule says nothing about them.
 * Why: a tripped (auto-resetting) motor breaker cuts that mechanism in the middle of a match; an intake roller stalled
 * for seconds is the usual case.
 */
import { rule, round } from '../rule.ts'
import { CTRE_BREAKER_DATASHEET, CTRE_CURRENT_LIMITS, GAME_MANUAL_2026, REV_ATO_DATASHEET, SNAP_ACTION_MX5 } from '../sources.ts'
import { DT } from '../../power/battery-model.ts'
import { breakerFamily, heat } from '../../power/breakers.ts'
import { breakerForMotor, FASTEST_LEGAL, type MotorBreaker, type PowerMap } from '../../power/power-map.ts'
import { inside, type MatchView, type MotorView } from '../view.ts'

const FAMILY_NAMES: Record<string, string> = { 'rev-ato': 'REV', 'ctre-ato': 'CTRE', 'snap-action': 'Snap Action', atm: 'ATM' }

export default rule({
  id: 'power/pdp-breaker-margin',
  title: 'Close to tripping a motor\'s breaker',
  severity: 'warning',
  judges: 'performance',
  who: ['software', 'drive'],
  forEach: 'motor',
  meaning: 'This motor\'s supply current heated its power distribution breaker as fast as the quickest in-spec breaker of its kind trips, by the datasheet. If yours is at that end of its band, the breaker would have opened and the motor would have stopped until it reset.',
  causes: [
    { id: 'stall', cause: 'The mechanism stalled or jammed with the motor still driven', look: 'the match video at that time; the Power tab: this motor\'s current against the mechanism\'s speed' },
    { id: 'no-sustained-limit', cause: 'No sustained supply limit, so the motor can hold its burst limit', look: 'the Limits tab: this group\'s supply limit and lower limit' },
    { id: 'wrong-breaker', cause: 'The breaker is smaller, or a faster kind, than the one the pit thinks is in this slot', look: 'the breaker in the slot (rating printed on it) against the power map' },
  ],
  nextStep: 'Find what held the motor at that current (a jam, a stall), and give the group a sustained supply limit under the breaker\'s rating.',
  incident: 'Auto-resetting breakers on mechanism motors open in a match when a roller or arm jams; Phoenix\'s default supply limit lets a Kraken draw 70 A for a second.',
  sources: [
    { ...GAME_MANUAL_2026, says: 'R619 lists the breakers allowed on the power distribution board; R621 allows one motor controller per breaker.' },
    { ...REV_ATO_DATASHEET, says: 'The REV ATO breaker data sheet gives the band of trip time against percent of rating for 10 to 40 A.' },
    { ...CTRE_BREAKER_DATASHEET, says: 'The CTRE breaker data sheet gives its band and bench trip times for 10 to 40 A.' },
    { ...SNAP_ACTION_MX5, says: 'The Snap Action sheet (one table for MX5, AT2 and VB3, up to 40 A) gives the fastest legal PDP breaker\'s trip times.' },
    { ...CTRE_CURRENT_LIMITS, says: 'FRC breakers mostly trip from heat and can carry well above their rating for a limited time; check the breaker data sheet for trip times.' },
  ],
  thresholds: [
    { name: 'warn line', value: 'the fast edge of the datasheet band reaches 100 %', basis: 'judgment', how: 'Taken from the makers\' datasheets (REV, CTRE, Snap Action), fitted per edge by heating stages; good to about ±20 to 30 % in heat. 1 of 7,488 motor-matches in 463 matches reached it, an intake roller at 100 A; no trip is known, so the line rests on the datasheet alone.' },
    { name: 'breaker when none is set', value: 'the fastest legal: Snap Action, 40 A', basis: 'judgment', how: 'Snap Action trips 3 to 15 times sooner than REV at 200 % and soonest from about 140 % of its rating up; below about 133 % its fast edge never trips, where REV and CTRE do (at 125 % they trip in 32 and 18 s), so a long mild overload is not caught until the breaker is set.' },
  ],

  // Only motors whose supply current the profile names: the breaker sees that current.
  only: (motor, match) => !!profileMotor(motor, match)?.supplyCurrent,
  check(motor, match) {
    if (match.wholeMatch.length === 0) return match.couldNotCheck('no match in this log')
    motor.supply() // the log lacks this motor's current: not checked, as for every motor rule
    const grid = match.currents()
    const logged = grid.motors.find((m) => m.name === motor.name && m.group === motor.group)
    if (!logged) return match.couldNotCheck(`${motor.name} supply current is not logged`)
    const breaker = breakerForMotor(match.powerMap, motor.name, motor.canId)
    const family = breakerFamily(breaker.family)
    if (!family) return match.couldNotCheck(`${motor.name} is on an ${FAMILY_NAMES[breaker.family] ?? breaker.family} breaker, which has no trip curve here yet`)

    const fast = heat(logged.amps, DT, breaker.ratingA, family.edges.fast)
    const slow = heat(logged.amps, DT, breaker.ratingA, family.edges.slow)
    let fastAt = -1
    let slowPeak = 0
    let amps = 0
    let seconds = 0
    let crossAt = -1
    for (let i = 0; i < fast.length; i++) {
      if (!inside(match.wholeMatch, grid.t[i])) continue
      if (fastAt < 0 || fast[i] > fast[fastAt]) fastAt = i
      if (slow[i] > slowPeak) slowPeak = slow[i]
      if (logged.amps[i] > amps) amps = logged.amps[i]
      if (logged.amps[i] > breaker.ratingA) seconds += DT
      if (crossAt < 0 && fast[i] >= 1) crossAt = i
    }
    if (fastAt < 0) return match.couldNotCheck('no motor current logged during the match')
    const fastPeak = fast[fastAt]
    if (fastPeak < 1) return

    const t = grid.t[crossAt]
    const fastPercent = Math.round(100 * fastPeak)
    const slowPercent = Math.round(100 * slowPeak)
    const can = motor.canId !== undefined ? ` (CAN ${motor.canId})` : ''
    return {
      message: `${motor.name}${can} · ${where(match.powerMap, breaker)}: a fast-end breaker would have tripped ${match.whenAt(t)} (fast ${fastPercent} %, slow ${slowPercent} %)`,
      at: t,
      evidence: {
        'fast edge, peak heat (% of the trip)': fastPercent,
        'slow edge, peak heat (% of the trip)': slowPercent,
        'peak supply current (A)': round(amps, 1),
        'seconds above the breaker\'s rating': round(seconds, 1),
        'breaker': `${breakerName(breaker)} (${SOURCE_WORDS[breaker.source]})`,
        'slot': breaker.slot !== undefined ? slotName(match.powerMap, breaker) : 'not mapped',
      },
      measured: [{ label: `${motor.name} breaker heat, fast edge`, value: fastPercent, unit: '%', threshold: 100 }],
      plot: { signals: [motor.supply()], unit: 'A', from: t - 30, to: t + 10, marks: [t], line: { value: breaker.ratingA, label: `${breaker.ratingA} A rating` } },
    }
  },
})

const SOURCE_WORDS: Record<MotorBreaker['source'], string> = { slot: 'set on its slot in the power map', usual: 'the power map\'s usual breaker', 'not set': 'not set: the fastest legal breaker is assumed' }

const breakerName = (b: MotorBreaker) => `${FAMILY_NAMES[b.family] ?? b.family} ${b.ratingA} A`

function slotName(map: PowerMap | null, b: MotorBreaker): string {
  const board = map?.boards.find((x) => x.id === b.board)
  return `${board?.kind === 'rev-mpm' ? `MPM ${b.board}` : 'PDP'} slot ${b.slot}`
}

/** "PDP slot 7 · REV 40 A", "slot not mapped · REV 40 A", or the not-set wording. */
function where(map: PowerMap | null, b: MotorBreaker): string {
  const slot = b.slot !== undefined ? slotName(map, b) : 'slot not mapped'
  if (b.source === 'not set') return `${slot} · breaker not set: judged against the fastest legal ${FASTEST_LEGAL.ratingA} A breaker (${FAMILY_NAMES[FASTEST_LEGAL.family]})`
  return `${slot} · ${breakerName(b)}`
}

function profileMotor(motor: MotorView, match: MatchView) {
  return match.profile.motorGroups.find((g) => g.name === motor.group)?.motors.find((m) => m.name === motor.name)
}
