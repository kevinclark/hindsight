/**
 * Did the roboRIO brown out?
 *
 * Checks: every time the brownout flag turns on (the robot log's, or the Driver Station log's when the robot log has
 * none). Below the brownout setting the roboRIO switches every motor off until the voltage recovers: the robot goes
 * limp.
 * Why: One 2026 match browned out 53 times in the last 18 s; nine shots in a row failed.
 */
import { plural, rule, round } from '../rule.ts'
import { MOTOR_CURRENT_LABEL, type PowerGrid } from '../../power/battery-model.ts'
import { batteryHealth } from './battery-health.ts'

export default rule({
  id: 'power/brownout',
  title: 'roboRIO brownout',
  severity: 'error',
  who: ['software', 'pit'],
  meaning: 'The battery voltage fell below the roboRIO\'s brownout level (the "brownout setting" below), so it switched every motor off until the voltage recovered. The robot went limp.',
  causes: [
    { id: 'load', cause: 'Too much current drawn at once (several big motors starting together, current limits off)', look: 'Power tab: total current and the biggest motor group at each sag; the Limits tab for groups with no current limit' },
    { id: 'weak-battery', cause: 'A weak, worn or partly charged battery that sags a lot under load', look: 'the power/battery-collapse and power/rest-voltage findings; a load test of this battery' },
    { id: 'wiring', cause: 'High resistance in the battery leads, connectors or main breaker', look: 'Power tab: battery + wiring resistance (over 20 mΩ is high); tug-test and re-crimp the battery leads and main breaker lugs' },
    { id: 'loose-connection', cause: 'A connection that opens and closes (battery connector, main breaker, roboRIO power) when the robot is bumped', look: 'did the brownouts follow a bump or hit (collision/impact)? Wiggle-test the battery connector and the roboRIO power plug' },
  ],
  nextStep: 'Find the loads on at each sag (Power tab), turn on current limits for the big ones, and load-test the battery used.',
  incident: 'One 2026 match: brownouts from 532.8 s, battery collapse after ~3.5 Ah',

  check(match) {
    const onsets = match.signal('brownedOut').turnsOn()
    if (onsets.length === 0) return
    const first = onsets[0]
    const last = onsets[onsets.length - 1]
    const battery = match.signal('batteryVoltage')
    const lowest = round(battery.lowest(match.between(first - 1, first + 1)).value)
    // Context only: a log without the setting or the motor currents still gets its brownouts reported.
    const setting = match.signalIfLogged('brownoutVoltage')?.last() ?? NaN
    // A check on the count: the Driver Station's own count during this log, when its event log is loaded.
    const dsCount = match.signalIfLogged('dsBrownoutCount', 'Driver Station brownout count')?.last()
    const power = match.powerIfLogged()
    const health = batteryHealth(match, power)
    const load = power ? loadAt(power.grid, first) : null
    const currentLabel = power?.grid.currentLabel ?? MOTOR_CURRENT_LABEL

    // Which cause this log points to. A collapsed battery (power/battery-collapse) comes before the load: it has
    // normal resistance, so resistance alone can't tell it from too much load.
    const likely: string[] = []
    let nextStep: string | undefined
    if (health.collapse) {
      likely.push('weak-battery')
      const { below, ah } = health.collapse
      nextStep = `The battery fell ${below.toFixed(1)} V below a healthy one at ${ah} Ah drawn: swap the battery first and capacity-test it (see power/battery-collapse).`
    } else if (health.wiringHigh) {
      likely.push('wiring', 'weak-battery')
    } else if (health.wiringFine) {
      likely.push('load', 'weak-battery')
      const biggest = load?.biggest ? ` (${load.biggest} drew the most at the first brownout)` : ''
      nextStep = `Resistance is fine, so look at the load${biggest}: turn on current limits for the big motors, and load-test the battery used.`
    }
    const ruledOut: Record<string, string> = {}
    if (health.wiringFine) ruledOut.wiring = `battery + wiring resistance was only ${health.milliohms} mΩ`

    return {
      message: `Browned out ${plural(onsets.length, 'time')}, first ${match.whenAt(first)}`,
      at: first,
      likely, ruledOut, nextStep,
      evidence: {
        'brownout onsets': onsets.length,
        'the Driver Station counted (this log)': dsCount,
        'last brownout': match.when(last),
        [`${currentLabel} at the first brownout (A)`]: load ? round(load.amps, 0) : 'not logged',
        'battery + wiring resistance (mΩ)': health.milliohms ?? 'not measured',
        'lowest voltage around the first (V)': lowest,
        'brownout setting (V)': Number.isNaN(setting) ? 'not logged' : setting,
      },
      measured: [
        // Context only: a brownout happens at the setting by definition, so "how far past it" says nothing.
        { label: 'brownouts', value: onsets.length, unit: '' },
        { label: 'lowest voltage at the first brownout', value: lowest, unit: 'V' },
      ],
      plot: {
        signals: [battery], unit: 'V', from: first - 8, to: Math.min(first + 12, last + 2), marks: onsets,
        line: Number.isNaN(setting) ? undefined : { value: setting, label: 'brownout setting' },
      },
    }
  },
})

/** The total motor current at time t, and the group drawing the most (null before the power grid starts). */
function loadAt(grid: PowerGrid, t: number) {
  const i = grid.t.findIndex((x) => x >= t)
  if (i < 0) return null
  const biggest = grid.groups.length ? grid.groups.reduce((a, b) => (b.amps[i] > a.amps[i] ? b : a)).name : ''
  return { amps: grid.amps[i], biggest }
}
