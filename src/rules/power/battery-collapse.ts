/**
 * power/battery-collapse — did this battery run out of capacity during the match?
 *
 * Checks: the estimated open-circuit voltage (V + R·I) at each 0.5 Ah of charge drawn, against the fleet curve
 * (src/power/fleet-reference.ts). Fires when any point is more than 1.5 V below the curve. Red when the match
 * also browned out, amber otherwise.
 * Why: CalGames 2026 P0's battery matched Q13/Q21 for the first ~3.5 Ah, then collapsed: ~8 V at 6.25 Ah where a
 * healthy battery reads ~10.4 V. It was fully charged (12.66 V) and the wiring was fine (11 mΩ). It was weak.
 * When it fires: pull that battery from competition and capacity-test it (AndyMark CBA, 10 A to 11 V).
 */
import { num, type Match } from '../../match/match.ts'
import { buildPowerGrid, ocvCurve, resistanceFromSteps } from '../../power/battery-model.ts'
import { FLEET_REFERENCE, fleetVoltageAt } from '../../power/fleet-reference.ts'
import type { Finding, NotChecked, PartlyChecked, Rule } from '../types.ts'

const GAP_VOLTS = 1.5

export const batteryCollapse: Rule = {
  id: 'power/battery-collapse',
  title: 'Battery capacity collapse',
  audience: ['pit'],
  fix: 'Take this battery out of competition use and capacity-test it (AndyMark CBA, 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0: estimated open-circuit voltage collapsed after ~3.5 Ah (hindsight-research/REVIEW.md items 1–3)',
  needs: (m: Match) => [m.profile.signals.batteryVoltage, m.profile.signals.enabled],
  run(m: Match): Finding[] | NotChecked | PartlyChecked {
    const grid = buildPowerGrid(m)
    if (!grid) return { notChecked: 'no motor supply currents in this log' }
    const r = resistanceFromSteps(grid)
    if (!r) return { notChecked: 'too few current steps to estimate resistance' }
    const curve = ocvCurve(grid, r.ohms, 0.5)
    let worst = { gap: 0, ah: 0, volts: 0, reference: 0, t: 0 }
    let beyond = 0 // charge past the end of the reference curve can't be compared
    for (const p of curve) {
      const reference = fleetVoltageAt(p.ah)
      if (!Number.isFinite(reference)) { beyond = Math.max(beyond, p.ah); continue }
      const gap = reference - p.volts
      if (gap > worst.gap) worst = { gap, ah: p.ah, volts: p.volts, reference, t: p.t }
    }
    const unchecked = beyond ? [`charge past ${FLEET_REFERENCE.at(-1)!.ah} Ah (to ${beyond} Ah): no healthy-battery reference there`] : []
    if (worst.gap <= GAP_VOLTS) return unchecked.length ? { findings: [], missing: unchecked } : []
    const brownedOut = num(m, m.profile.signals.brownedOut)
    const anyBrownout = !!brownedOut && Array.from(brownedOut.v).some((v) => v > 0.5)
    const findings: Finding[] = [{
      rule: this.id,
      severity: anyBrownout ? 'error' : 'warning',
      title: `Battery fell ${worst.gap.toFixed(1)} V below a healthy battery at ${worst.ah} Ah drawn`,
      time: worst.t,
      evidence: {
        'charge drawn (Ah)': worst.ah,
        'estimated open-circuit voltage (V)': +worst.volts.toFixed(2),
        'healthy battery at that charge (V)': +worst.reference.toFixed(2),
        'gap (V)': +worst.gap.toFixed(2),
        'battery + wiring resistance used (mΩ)': +(r.ohms * 1000).toFixed(1),
        'match also browned out': anyBrownout ? 'yes' : 'no',
      },
    }]
    return unchecked.length ? { findings, missing: unchecked } : findings
  },
}
