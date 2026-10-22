/**
 * How close did the robot's total current come to tripping the 120 A main breaker?
 *
 * Checks: the breaker heats with current squared and cools over time, so its load is the root of an exponential
 * average of total current² (time constant τ). Fires when that load reaches 100 % of 120 A, the bottom of the band
 * (100–130 % at room temperature) where the main breaker's long-run trip lies; red at 130 %, above the band.
 * Thresholds: from the CB185-120 datasheet's curve read by eye (±15–30 %), so the band is wide on purpose. τ = 90 s
 * is the lowest time constant under which three real matches that did NOT trip stay under the band's slow edge
 * (one reached 128 % at 90 s and 150 % at 30 s); each finding also says the lowest τ its own match allows. A
 * one-τ model is only an approximation: at 90 s it predicts a 300 % overload trips in ~19 s where the datasheet says
 * 5–13 s, so short hard pushes are better judged by the 30 s figure in the evidence.
 * Why: the main breaker cuts power to the whole robot and has to be reset by hand. Teams trip it most when pushed
 * for a long time, or with supply limits off; a warm breaker, or loose lugs, trip it sooner.
 */
import { rule, round, type PlotRequest } from '../rule.ts'
import { DT, type PowerGrid } from '../../power/battery-model.ts'
import { inside, type MatchView } from '../view.ts'

const MAIN_BREAKER_A = 120 // FRC rule R609: one 120 A main breaker
const TRIP_BAND = [1.0, 1.3] // long-run trip, as a share of 120 A, at 25 °C (CB185-120 datasheet, read by eye)
const TAU_SECONDS = 90 // see "Thresholds" above

export default rule({
  id: 'power/main-breaker-margin',
  title: 'Close to tripping the main breaker',
  severity: 'warning',
  who: ['software', 'drive'],
  meaning: 'The total current was high for long enough to heat the 120 A main breaker into the range where it can trip. If it trips, the whole robot goes dead until someone resets it by hand.',
  causes: [
    { id: 'pushing', cause: 'Long pushing matches: drive motors held at high current while pinned or wheel-spinning', look: 'the match video at the peak; Power tab: the drive group\'s current in the minute before it' },
    { id: 'no-sustained-limit', cause: 'No sustained current limit, so motors can sit at their burst limit indefinitely', look: 'the Limits tab: supply limits switched off, or no lower limit and lower time (Phoenix 6: SupplyCurrentLowerLimit / SupplyCurrentLowerTime)' },
    { id: 'busy-mechanism', cause: 'A big mechanism running hard for long stretches (a flywheel spun up all match, an intake stalled)', look: 'Power tab: which group carries the most current in the minute before the peak (this finding names it)' },
    { id: 'warm-breaker', cause: 'A breaker that is already warm, worn, or has loose lugs trips sooner than its curve', look: 'the main breaker\'s lugs (tight? discoloured?); whether it has tripped before (replace one that has)' },
  ],
  nextStep: 'Set a sustained supply limit on the drive and the biggest mechanisms (a lower limit after about 1 s), and make sure the sum of those sustained limits stays at or under about 120 A.',
  incident: 'Main-breaker trips while being pushed are a known FRC failure (Chief Delphi threads on main-breaker trips, 2024 and 2026).',

  check(match) {
    if (match.wholeMatch.length === 0) return match.couldNotCheck('no match in this log')
    // Heating needs current only, so this runs on a log with motor currents and no battery voltage too.
    const grid = match.currents()
    const load = heating(grid.amps, TAU_SECONDS)
    // The peak is looked for inside the match only: heat builds up over the whole log, but a reading held after the
    // match ended is not the match. (No match, no finding: the guard above also leaves out Foresight's pit stretch.)
    const peakAt = indexOfHighest(load, grid.t, match.wholeMatch)
    if (peakAt < 0) return match.couldNotCheck('no motor current logged during the match')
    const share = load[peakAt] / MAIN_BREAKER_A
    if (share < TRIP_BAND[0]) return

    const t = grid.t[peakAt]
    const tauMin = lowestSafeTau(grid.amps)
    const fasterPercent = loadPercent(grid.amps, 30)
    const slowerPercent = loadPercent(grid.amps, 180)
    // The minute before the peak: which group carried the most current, and the total's RMS.
    const from = Math.max(0, peakAt - Math.round(60 / DT))
    const top = busiestGroup(grid, from, peakAt)
    const total = sumBetween(grid.amps, from, peakAt)
    const rms60 = rmsBetween(grid.amps, from, peakAt)
    const topPercent = top && total > 0 ? Math.round((100 * top.charge) / total) : undefined

    const plot = peakPlot(match, t, top?.name)

    return {
      message: `Main breaker load reached ${Math.round(100 * share)} % of its ${MAIN_BREAKER_A} A rating ${match.whenAt(t)}, ${share >= TRIP_BAND[1] ? 'above' : 'inside'} the ${100 * TRIP_BAND[0]}–${100 * TRIP_BAND[1]} % band where it can trip`,
      at: t,
      severity: share >= TRIP_BAND[1] ? 'error' : undefined,
      evidence: {
        [`breaker load, heating averaged over ~${TAU_SECONDS} s (% of ${MAIN_BREAKER_A} A)`]: Math.round(100 * share),
        'same, if the breaker heats faster (30 s; closer for short hard pushes) (%)': fasterPercent,
        'same, if it heats slower (180 s) (%)': slowerPercent,
        'total current, RMS over the minute before (A)': round(rms60, 0),
        'carried most of it': top && topPercent !== undefined ? `${top.name} (${topPercent} % of the current)` : 'unknown',
        'if it did not trip, under this model its time constant is at least (s)': tauMin ?? 'over 300',
      },
      measured: [{ label: `main breaker load (~${TAU_SECONDS} s)`, value: Math.round(100 * share), unit: '%', threshold: 100 * TRIP_BAND[0] }],
      nextStep: top && topPercent !== undefined
        ? `${top.name} carried ${topPercent} % of the current in the minute before: give it a sustained supply limit (a lower limit after about 1 s), and keep the sum of the sustained limits at or under about 120 A.`
        : undefined,
      plot,
    }
  },
})

/** The breaker's load over time: the root of the exponential average of current², with time constant tau (s). */
function heating(amps: Float64Array, tau: number): Float64Array {
  const out = new Float64Array(amps.length)
  let h = 0
  for (let i = 0; i < amps.length; i++) {
    h += (amps[i] * amps[i] - h) * (DT / tau)
    out[i] = Math.sqrt(h)
  }
  return out
}

/** Only the highest load, without keeping the series (for trying many time constants). */
function peakHeating(amps: Float64Array, tau: number): number {
  let h = 0
  let peak = 0
  for (let i = 0; i < amps.length; i++) {
    h += (amps[i] * amps[i] - h) * (DT / tau)
    if (h > peak) peak = h
  }
  return Math.sqrt(peak)
}

/** The index of the highest value whose time falls inside the window (the first, if several tie). */
function indexOfHighest(values: Float64Array, times: Float64Array, window: MatchView['wholeMatch']): number {
  let highest = -1
  for (let i = 0; i < values.length; i++) {
    if (!inside(window, times[i])) continue
    if (highest < 0 || values[i] > values[highest]) highest = i
  }
  return highest
}

/** The lowest time constant under which this match stays below the band's slow edge (null: none up to 300 s). */
function lowestSafeTau(amps: Float64Array): number | null {
  for (let tau = 10; tau <= 300; tau += 5) {
    if (peakHeating(amps, tau) / MAIN_BREAKER_A <= TRIP_BAND[1]) return tau
  }
  return null
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

/** The peak load of the main breaker at time constant tau, in whole percent of its rating. */
function loadPercent(amps: Float64Array, tau: number): number {
  return Math.round(100 * peakHeating(amps, tau) / MAIN_BREAKER_A)
}

/** The group that carried the most current from index `from` to `to` (current adds up by group; heating doesn't). */
function busiestGroup(grid: PowerGrid, from: number, to: number) {
  const groups = grid.groups.map((g) => ({ name: g.name, charge: sumBetween(g.amps, from, to) }))
  groups.sort((a, b) => b.charge - a.charge)
  return groups[0]
}

/** The plot around the peak: battery voltage if logged; otherwise the supply current of the group that carried most. */
function peakPlot(match: MatchView, t: number, topGroup: string | undefined): PlotRequest {
  const battery = match.signalIfLogged('batteryVoltage')
  if (battery) return { signals: [battery], unit: 'V', from: t - 60, to: t + 10, marks: [t] }
  const motors = match.profile.motorGroups.find((g) => g.name === topGroup)?.motors ?? []
  const supply = motors.flatMap((m) => (m.supplyCurrent && match.has(m.supplyCurrent) ? [match.signal(m.supplyCurrent, `${m.name} supply`)] : []))
  return { signals: supply, unit: 'A', from: t - 60, to: t + 10, marks: [t] }
}
