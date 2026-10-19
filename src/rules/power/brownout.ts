/**
 * Did the roboRIO brown out?
 *
 * Checks: every time /SystemStats/BrownedOut turns on. Below the brownout setting the roboRIO switches every
 * motor off until the voltage recovers: the robot goes limp.
 * Why: CalGames 2026 P0 browned out 53 times in the last 18 s; nine shots in a row failed.
 */
import { rule, round } from '../rule.ts'
import { furthestBelowHealthy, MOST_BELOW_HEALTHY } from './battery-collapse.ts'

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
  incident: 'CalGames 2026 P0: brownouts from 532.8 s, battery collapse after ~3.5 Ah (8033/robot/2026-10-17-calgames-q13-log-analysis.md, P0 section)',

  check(match) {
    const onsets = match.signal('brownedOut').turnsOn()
    if (onsets.length === 0) return
    const first = onsets[0]
    const last = onsets[onsets.length - 1]
    const battery = match.signal('batteryVoltage')
    // The setting is context; a log without it still gets its brownouts reported.
    const setting = match.has('brownoutVoltage') ? match.signal('brownoutVoltage').last() : NaN
    // The battery + wiring resistance and the current at the first brownout, from the power model. Optional: a log
    // without motor currents still gets its brownouts reported.
    const power = match.powerIfLogged()
    const ohms = power?.report.resistanceOhms ?? null
    const i = power ? power.grid.t.findIndex((t) => t >= first) : -1
    const amps = power && i >= 0 ? power.grid.amps[i] : null
    const biggest = power && i >= 0 && power.grid.groups.length ? power.grid.groups.reduce((a, b) => (b.amps[i] > a.amps[i] ? b : a)).name : ''
    // A battery that fell far below a healthy one (power/battery-collapse) is the cause before the load is: a
    // collapsed battery has normal resistance, so resistance alone can't tell it from too much load.
    const collapse = power && ohms !== null ? furthestBelowHealthy(power.grid, ohms) : null
    const collapsed = collapse !== null && collapse.healthy - collapse.volts > MOST_BELOW_HEALTHY
    // Resistance past the "good battery" line points at battery or wiring; at or under it, the load is the bigger part.
    const wiringHigh = ohms !== null && ohms > match.profile.power.healthyResistanceMaxOhms
    const wiringFine = ohms !== null && !wiringHigh
    return {
      likely: collapsed ? ['weak-battery'] : wiringHigh ? ['wiring', 'weak-battery'] : wiringFine ? ['load', 'weak-battery'] : undefined,
      ruledOut: wiringFine ? { wiring: `battery + wiring resistance was only ${round(ohms! * 1000, 1)} mΩ` } : undefined,
      nextStep: collapsed ? `The battery fell ${(collapse!.healthy - collapse!.volts).toFixed(1)} V below a healthy one at ${collapse!.ah} Ah drawn: swap the battery first and capacity-test it (see power/battery-collapse).`
        : wiringFine ? `Resistance is fine, so look at the load${biggest ? ` (${biggest} drew the most at the first brownout)` : ''}: turn on current limits for the big motors, and load-test the battery used.` : undefined,
      message: `Browned out ${onsets.length} time${onsets.length === 1 ? '' : 's'}, first at ${match.when(first)}`,
      at: first,
      evidence: {
        'brownout onsets': onsets.length,
        'first brownout': match.when(first),
        'last brownout': match.when(last),
        'first (robot time, s)': round(first),
        'last (robot time, s)': round(last),
        'total motor current at the first brownout (A)': amps === null ? 'not logged' : round(amps, 0),
        'battery + wiring resistance (mΩ)': ohms === null ? 'not measured' : round(ohms * 1000, 1),
        'lowest voltage around the first (V)': round(battery.lowest(match.between(first - 1, first + 1)).value),
        'brownout setting (V)': Number.isNaN(setting) ? 'not logged' : setting,
      },
      measured: [
        // Context only: a brownout happens at the setting by definition, so "how far past it" says nothing.
        { label: 'brownouts', value: onsets.length, unit: '' },
        { label: 'lowest voltage at the first brownout', value: round(battery.lowest(match.between(first - 1, first + 1)).value), unit: 'V' },
      ],
      plot: [battery], plotUnit: 'V', plotFrom: first - 8, plotTo: Math.min(first + 12, last + 2),
      plotLine: Number.isNaN(setting) ? undefined : { value: setting, label: 'brownout setting' }, plotMarks: onsets,
    }
  },
})
