/**
 * Would the main breaker have tripped, by its maker's own trip curve?
 *
 * Checks: the datasheet gives a band, the earliest an in-spec 120 A main breaker may trip (the fast edge) and the
 * latest (the slow edge). The robot's total current heats each edge the way that edge's curve says (src/power/breakers.ts:
 * heating with current squared, cooling when it drops). Fires when the fast edge reaches 100 %: a breaker at the fast
 * end of its band would have tripped. Amber only, never red: three matches that did not trip went past the slow edge
 * too (103 to 108 %), and the chart's time axis past 20 s is hand-drawn (about ±30 % in time), so past the slow edge
 * cannot be called certain.
 * Thresholds: the makers' datasheets (Bussmann 18X/28X, Optifuse 153/253), fitted per edge; the fit is off by up to ±14 %
 * in current at a datasheet point for the Bussmann fast edge, which is about ±30 % in heat (heat goes with current squared).
 * Why: the main breaker cuts power to the whole robot and has to be reset by hand. Teams trip it most when pushed for a
 * long time, or with supply limits off; a warm breaker, or loose lugs, trip it sooner (the curves are at 25 °C).
 */
import { rule, round, type PlotRequest } from '../rule.ts'
import { BUSSMANN_SERIES_18X, BUSSMANN_SERIES_28X, CD_MAIN_BREAKER_CAUSES, CD_MAIN_BREAKER_TRIPS, CTRE_CURRENT_LIMITS, GAME_MANUAL_2026, OPTIFUSE_153, OPTIFUSE_253, REV_ATO_BREAKERS } from '../sources.ts'
import { DT, type PowerGrid } from '../../power/battery-model.ts'
import { breakerFamily, heat, steadyAmps } from '../../power/breakers.ts'
import { mainBreakerFor, type MainFamily } from '../../power/power-map.ts'
import { inside, lengthOf, type MatchView } from '../view.ts'

const MAIN_BREAKER_A = 120 // FRC rule R609: one 120 A main breaker

/** The parts each main family stands for, as a student reads them on the breaker. */
const PARTS: Record<MainFamily, string> = {
  bussmann: 'Bussmann CB185-120 or CB285-120',
  optifuse: 'Optifuse 153120 or 253120',
}
export default rule({
  id: 'power/main-breaker-margin',
  title: 'Close to tripping the main breaker',
  severity: 'warning',
  judges: 'performance',
  averagesOverTime: true, // a heating average over tens of seconds
  who: ['software', 'drive'],
  meaning: 'The total current heated a 120 A main breaker as fast as the quickest in-spec breaker trips, by its datasheet. Whether yours would have tripped depends on where in its band it sits. If it trips, the whole robot goes dead until someone resets it by hand.',
  causes: [
    { id: 'pushing', cause: 'Long pushing matches: drive motors held at high current while pinned or wheel-spinning', look: 'the match video at the peak; Power tab: the drive group\'s current in the minute before it' },
    { id: 'no-sustained-limit', cause: 'No sustained current limit, so motors can sit at their burst limit indefinitely', look: 'the Limits tab: supply limits switched off, or no lower limit and lower time (Phoenix 6: SupplyCurrentLowerLimit / SupplyCurrentLowerTime)' },
    { id: 'busy-mechanism', cause: 'A big mechanism running hard for long stretches (a flywheel spun up all match, an intake stalled)', look: 'Power tab: which group carries the most current in the minute before the peak (this finding names it)' },
    { id: 'warm-breaker', cause: 'A breaker that is already warm, worn, or has loose lugs trips sooner than its curve', look: 'the main breaker\'s lugs (tight? discoloured?); whether it has tripped before (replace one that has)' },
  ],
  nextStep: 'Set a sustained supply limit on the drive and the biggest mechanisms (a lower limit after about 1 s), and keep the total they can draw for a whole match under the steady current in the evidence.',
  incident: 'Main-breaker trips while being pushed are a known FRC failure (Chief Delphi threads on main-breaker trips, 2024 and 2026).',
  sources: [
    { ...GAME_MANUAL_2026, says: 'Rule R609: the robot has a single main 120 A surface-mount circuit breaker (Cooper Bussmann CB185-120 or the listed equivalents); R612 allows only one 120 A breaker.' },
    { ...BUSSMANN_SERIES_18X, says: 'The Series 18X data sheet gives the band of trip time against percent of rated current (fastest and slowest in-spec breaker) and a temperature derating curve; its curves are at 25 °C.' },
    { ...BUSSMANN_SERIES_28X, says: 'The Series 28X (CB285-120) page gives the same band, identical to the 18X after a page offset.' },
    { ...OPTIFUSE_153, says: 'The 153 data sheet gives the Optifuse band of trip time against percent of rated current, with a three-row table.' },
    { ...OPTIFUSE_253, says: 'The 253 data sheet gives the same band for the other legal Optifuse part.' },
    { ...CTRE_CURRENT_LIMITS, says: 'FRC breakers mostly trip from heat and can carry well above their rating for a limited time; check the breaker data sheet for trip times.' },
    { ...REV_ATO_BREAKERS, says: 'A breaker is designed to trip at a temperature after a set time, not at an exact current; its rating is the most it is guaranteed to carry without tripping (the page is about a 40 A ATO breaker).' },
    { ...CD_MAIN_BREAKER_TRIPS, says: 'A poster reports more main-breaker trips in 2024 as teams moved to swerve without current limits; one team\'s PDH log showed about 120 A from the battery for most of a match until the breaker tripped.' },
    { ...CD_MAIN_BREAKER_CAUSES, says: 'One team traced main-breaker trips to a damaged drive motor drawing excess current, a loose power wire, a breaker that popped on a tap, and battery leads shorting to the frame.' },
  ],
  thresholds: [
    { name: 'warn line', value: 'the fast edge of the datasheet band reaches 100 %', basis: 'judgment', how: 'Taken from the makers\' datasheets (Bussmann 18X and 28X, Optifuse 153 and 253), fitted per edge by heating stages; the line is good to about ±30 % in heat for the Bussmann fast edge (fit error in current, squared). No red level: three matches that did not trip passed the slow edge by 3 to 8 %.' },
    { name: 'datasheet temperature', value: '25 °C', basis: 'judgment', how: 'The curves are at 25 °C; a warm breaker or loose lugs trip sooner (Bussmann publishes 50 to 85 % of the band at 93 °C).' },
  ],

  check(match) {
    if (match.wholeMatch.length === 0) return match.couldNotCheck('no match in this log')
    // Heating needs current only, so this runs on a log with motor currents and no battery voltage too.
    const grid = match.currents()
    const main = mainBreakerFor(match.powerMap, match.profile.breakerDefault)
    const family = breakerFamily(main.family)!
    const fast = heat(grid.amps, DT, MAIN_BREAKER_A, family.edges.fast)
    const slow = heat(grid.amps, DT, MAIN_BREAKER_A, family.edges.slow)
    // The peak is looked for inside the match only: heat builds up over the whole log, but a reading held after the
    // match ended is not the match. (No match, no finding: the guard above also leaves out Foresight's pit stretch.)
    const fastAt = indexOfHighest(fast, grid.t, match.wholeMatch)
    const slowAt = indexOfHighest(slow, grid.t, match.wholeMatch)
    if (fastAt < 0 || slowAt < 0) return match.couldNotCheck('no motor current logged during the match')
    const fastPeak = fast[fastAt]
    const slowPeak = slow[slowAt]
    if (fastPeak < 1) return

    // When the fast edge first reached 100 % inside the match: the time a fast-end breaker would have tripped.
    const crossAt = fast.findIndex((h, i) => h >= 1 && inside(match.wholeMatch, grid.t[i]))
    const t = grid.t[crossAt]
    const fastPercent = Math.round(100 * fastPeak)
    const slowPercent = Math.round(100 * slowPeak)
    const slowTripped = slowPeak >= 1
    // The minute before it: which group carried the most current, and the total's RMS.
    const from = Math.max(0, crossAt - Math.round(60 / DT))
    const top = busiestGroup(grid, from, crossAt)
    const total = sumBetween(grid.amps, from, crossAt)
    const rms60 = rmsBetween(grid.amps, from, crossAt)
    const topPercent = top && total > 0 ? Math.round((100 * top.charge) / total) : undefined
    // The fit's worst error in current, as an error in heat (heat goes with current squared).
    const heatError = Math.round(100 * ((1 + family.edges.fast.fitError.currentWorst) ** 2 - 1))

    return {
      message: `Main breaker: a breaker at the fast end of its datasheet band would have tripped ${match.whenAt(t)}, ${slowTripped ? 'and so would the slowest' : 'though the slowest would not'}: fast edge ${fastPercent} %, slow edge ${slowPercent} %`,
      at: t,
      evidence: {
        'fast edge, peak heat (% of the trip)': fastPercent,
        'slow edge, peak heat (% of the trip)': slowPercent,
        'judged against': `${PARTS[main.family]}${main.source === 'assumed' ? ' (assumed: no main breaker set in the power map)' : main.source === 'default' ? ' (this robot\'s default)' : ' (set in the power map)'}`,
        'datasheet curves': 'at 25 °C; a warm breaker or loose lugs trip sooner',
        'accuracy of the warn line': `about ±${heatError} % in heat (the fit's worst error at a datasheet point, ${round(100 * family.edges.fast.fitError.currentWorst, 0)} % in current, squared)`,
        'steady total current that stays under the fast edge for this match\'s length (A)': round(steadyAmps(lengthOf(match.wholeMatch), MAIN_BREAKER_A, family.edges.fast), 0),
        'total current, RMS over the minute before (A)': round(rms60, 0),
        'carried most of it': top && topPercent !== undefined ? `${top.name} (${topPercent} % of the current)` : 'unknown',
      },
      measured: [{ label: 'main breaker heat, fast edge', value: fastPercent, unit: '%', threshold: 100 }],
      nextStep: top && topPercent !== undefined
        ? `${top.name} carried ${topPercent} % of the current in the minute before: give it a sustained supply limit (a lower limit after about 1 s), and keep the total the robot can draw for a whole match under the steady current in the evidence.`
        : undefined,
      plot: peakPlot(match, t, top?.name),
    }
  },
})

/** The index of the highest value whose time falls inside the window (the first, if several tie). */
function indexOfHighest(values: Float64Array, times: Float64Array, window: MatchView['wholeMatch']): number {
  let highest = -1
  for (let i = 0; i < values.length; i++) {
    if (!inside(window, times[i])) continue
    if (highest < 0 || values[i] > values[highest]) highest = i
  }
  return highest
}

/** The sum of a series from index `from` to `to`, both included. */
function sumBetween(values: Float64Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i <= to; i++) sum += values[i]
  return sum
}

/** The root-mean-square of a series from index `from` to `to`, both included. */
function rmsBetween(values: Float64Array, from: number, to: number): number {
  let squares = 0
  for (let i = from; i <= to; i++) squares += values[i] * values[i]
  return Math.sqrt(squares / (to - from + 1))
}

/** The group that carried the most current from index `from` to `to` (current adds up by group; heating doesn't). */
function busiestGroup(grid: PowerGrid, from: number, to: number) {
  const groups = grid.groups.map((g) => ({ name: g.name, charge: sumBetween(g.amps, from, to) }))
  groups.sort((a, b) => b.charge - a.charge)
  return groups[0]
}

/** The plot around the finding: battery voltage if logged; otherwise the supply current of the group that carried most. */
function peakPlot(match: MatchView, t: number, topGroup: string | undefined): PlotRequest {
  const battery = match.signalIfLogged('batteryVoltage')
  if (battery) return { signals: [battery], unit: 'V', from: t - 60, to: t + 10, marks: [t] }
  const motors = match.profile.motorGroups.find((g) => g.name === topGroup)?.motors ?? []
  const supply = motors.flatMap((m) => (m.supplyCurrent && match.has(m.supplyCurrent) ? [match.signal(m.supplyCurrent, `${m.name} supply`)] : []))
  return { signals: supply, unit: 'A', from: t - 60, to: t + 10, marks: [t] }
}
