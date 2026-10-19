/**
 * comms/loss — did the robot lose its connection to the Driver Station during the match?
 *
 * Checks: /SystemStats/CommsDisableCount going up, or /DriverStation/DSAttached going false, between the first
 * enable and the end of the match. Reports how long outputs stayed off (SystemActive false) after each loss.
 * Why: CalGames 2026 Q13 lost comms twice in the last 16 s (7.4 s and 4.3 s dead); the DS log stopped mid-match.
 * When it fires: pull the DS log and .dsevents for the match and the FTA's field log. Robot-side causes show as a
 * radio reboot or a brownout; DS-side causes as the DS log ending (comms/ds-log-truncated).
 */
import { num, type Match } from '../../match/match.ts'
import { inMatch, lowIn, when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

export const commsLoss: Rule = {
  id: 'comms/loss',
  title: 'Communications lost mid-match',
  audience: ['drive'],
  fix: 'Get the DS log + .dsevents for this match and the FTA field log. Check the DS laptop (CPU, power settings, app crash) and the radio (reboot = 20–40 s gap).',
  incident: 'CalGames 2026 Q13: comms lost at 417.4 s (7.4 s dead) and 426.4 s (4.3 s) (2026-10-17-calgames-q13-log-analysis.md §2)',
  needs: (m: Match) => [m.profile.signals.commsDisableCount, m.profile.signals.dsAttached],
  run(m: Match): Finding[] {
    const s = m.profile.signals
    const count = num(m, s.commsDisableCount)!
    const attached = num(m, s.dsAttached)!
    const active = num(m, s.systemActive)
    const volts = num(m, s.batteryVoltage)
    const losses: number[] = []
    for (let i = 1; i < count.t.length; i++) if (count.v[i] > count.v[i - 1] && inMatch(m, count.t[i])) losses.push(count.t[i])
    for (let i = 1; i < attached.t.length; i++) {
      const t = attached.t[i]
      if (attached.v[i] < 0.5 && attached.v[i - 1] > 0.5 && inMatch(m, t) && !losses.some((x) => Math.abs(x - t) < 10)) losses.push(t)
    }
    if (losses.length === 0) return []
    losses.sort((a, b) => a - b)
    const deadSeconds = losses.map((t) => {
      if (!active) return NaN
      const back = Array.from(active.t).find((x, i) => x > t && active.v[i] > 0.5)
      return back === undefined ? NaN : back - t
    })
    return [{
      rule: this.id,
      severity: 'error',
      title: `Lost comms ${losses.length} time${losses.length === 1 ? '' : 's'}, first at ${when(m, losses[0])}`,
      time: losses[0],
      evidence: {
        losses: losses.length,
        'loss times (s)': losses.map((t) => t.toFixed(1)).join(', '),
        'seconds with outputs off after each': deadSeconds.map((d) => (Number.isFinite(d) ? d.toFixed(1) : '?')).join(', '),
        'lowest battery voltage in the 0.5 s before each (V)': volts ? losses.map((t) => lowIn(volts, t - 0.5, t).value.toFixed(2)).join(', ') : 'not logged',
      },
      plot: {
        from: losses[0] - 5, to: losses[losses.length - 1] + 10, unit: '',
        lines: [{ label: 'DS attached', key: s.dsAttached }, ...(active ? [{ label: 'Outputs enabled', key: s.systemActive }] : [])],
        markers: losses.map((t) => ({ t, label: 'loss' })),
      },
    }]
  },
}
