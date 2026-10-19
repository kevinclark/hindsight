/**
 * Did the robot lose its connection to the Driver Station during the match?
 *
 * Checks: /SystemStats/CommsDisableCount going up, or DSAttached going false, during the match, and how long the
 * outputs stayed off after each.
 * Why: CalGames 2026 Q13 lost comms twice in the last 16 s (7.4 s and 4.3 s dead); the DS log stopped mid-match.
 */
import { isFalse, rule } from '../rule.ts'

export default rule({
  id: 'comms/loss',
  title: 'Communications lost mid-match',
  severity: 'error',
  who: ['drive'],
  fix: 'Get the DS log + .dsevents for this match and the FTA field log. Check the DS laptop (CPU, power settings, app crash) and the radio (reboot = 20–40 s gap).',
  incident: 'CalGames 2026 Q13: comms lost at 417.4 s (7.4 s dead) and 426.4 s (4.3 s) (2026-10-17-calgames-q13-log-analysis.md §2)',

  check(match) {
    const losses = match.signal('commsDisableCount').increases(match.wholeMatch)
    // A DS detach counts too, unless it is the same loss seen a few seconds later.
    for (const e of match.signal('dsAttached').episodes(isFalse)) {
      if (match.inMatch(e.start) && !losses.some((t) => Math.abs(t - e.start) < 10)) losses.push(e.start)
    }
    if (losses.length === 0) return
    losses.sort((a, b) => a - b)
    // How long the outputs stayed off, and the voltage just before: extra evidence, optional.
    const backOn = match.has('systemActive') ? match.signal('systemActive').turnsOn() : []
    const deadSeconds = losses.map((t) => (backOn.find((on) => on > t) ?? NaN) - t)
    const battery = match.has('batteryVoltage') ? match.signal('batteryVoltage') : null
    return {
      message: `Lost comms ${losses.length} time${losses.length === 1 ? '' : 's'}, first at ${match.when(losses[0])}`,
      at: losses[0],
      evidence: {
        losses: losses.length,
        'loss times (s)': losses.map((t) => t.toFixed(1)).join(', '),
        'seconds with outputs off after each': deadSeconds.map((d) => (Number.isFinite(d) ? d.toFixed(1) : '?')).join(', '),
        'lowest battery voltage in the 0.5 s before each (V)': battery ? losses.map((t) => battery.lowest(match.before(t, 0.5)).value.toFixed(2)).join(', ') : 'not logged',
      },
      plot: [match.signal('dsAttached', 'DS attached'), ...(match.has('systemActive') ? [match.signal('systemActive', 'Outputs enabled')] : [])],
      plotFrom: losses[0] - 5, plotTo: losses[losses.length - 1] + 10, plotMarks: losses,
    }
  },
})
