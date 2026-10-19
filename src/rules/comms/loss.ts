/**
 * Did the robot lose its connection to the Driver Station during the match?
 *
 * Checks: /SystemStats/CommsDisableCount going up, or DSAttached going false, during the match, and how long the
 * outputs stayed off after each.
 * Why: CalGames 2026 Q13 lost comms twice in the last 16 s (7.4 s and 4.3 s dead); the DS log stopped mid-match.
 *
 * Which cause it points to, from this log: the radio rebooted if the roboRIO lost the radio too, or the outputs
 * stayed off for 15 s or more (a radio boots in 20–40 s); a DS log that stops during the loss points to the DS laptop;
 * lost packets or a long trip time in the DS log just before point to the wireless link.
 */
import { isFalse, rule, round } from '../rule.ts'

const RADIO = '/RadioStatus/Connected' // AdvantageKit's radio logger: can the roboRIO reach the radio?
const RADIO_REBOOT_SECONDS = 15

export default rule({
  id: 'comms/loss',
  title: 'Communications lost mid-match',
  severity: 'error',
  who: ['drive'],
  meaning: 'The robot stopped hearing the Driver Station, so it disabled itself until the link came back.',
  causes: [
    { id: 'ds-laptop', cause: 'The Driver Station laptop or app (crash, sleep, power plan, CPU at 100 %)', look: 'the DS log for this match: does it stop, or does CPU spike, around the loss? Windows Event Viewer on the DS laptop for an app crash' },
    { id: 'radio', cause: 'The robot radio rebooted (power blip, loose power or Ethernet cable)', look: 'outputs off for 15 s or more after the loss (a radio takes 20–40 s to boot); the radio\'s power cable, its barrel/PoE connector and the Ethernet cable to the roboRIO' },
    { id: 'wireless', cause: 'The wireless link (interference, radio mounted near metal or motors)', look: 'the DS log: lost packets and trip time in the seconds before the loss; where the radio is mounted' },
    { id: 'field', cause: 'A problem on the field side', look: 'ask the FTA for the field log for this match' },
  ],
  nextStep: 'Load this match\'s .dslog too (on the DS laptop in C:\\Users\\Public\\Documents\\FRC\\Log Files): it tells a DS laptop problem from a radio or wireless one.',
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

    // Which cause this log points to.
    const likely: string[] = []
    const ruledOut: Record<string, string> = {}
    let nextStep: string | undefined
    let dsBefore: Record<string, number | string> = {}
    // The roboRIO losing the radio around a loss (from 5 s before to 45 s after): the radio went down with it.
    const radioLost = match.has(RADIO) && losses.some((t) => match.signal(RADIO).episodes(isFalse, { touching: match.between(t - 5, t + 45) }).length > 0)
    if (radioLost || deadSeconds.some((d) => d >= RADIO_REBOOT_SECONDS)) likely.push('radio')
    else if (match.has(RADIO)) ruledOut.radio = 'the roboRIO could reach the radio the whole match'
    if (match.dsLogs.length) {
      // A DS log that stops during a loss: the DS app closed or crashed.
      const cut = match.dsLogs.find((d) => losses.some((t) => d.endTime > t - 1 && d.endTime < t + 15))
      // The DS log's view of the 3 s before the first loss: lost packets, trip time, laptop CPU.
      const before = match.dsLogs.flatMap((d) => d.file.records)
        .filter((r) => match.epochOffset !== null && r.epochSeconds - match.epochOffset > losses[0] - 3 && r.epochSeconds - match.epochOffset < losses[0])
      const lostPct = before.length ? Math.max(...before.map((r) => r.lostPacketsPct)) : null
      if (before.length) {
        dsBefore = {
          'DS log, 3 s before the first loss: lost packets (%)': round(lostPct!, 0),
          'DS log, 3 s before the first loss: trip time (ms)': round(Math.max(...before.map((r) => r.tripTimeMs)), 1),
          'DS log, 3 s before the first loss: DS laptop CPU (%)': `${round(Math.min(...before.map((r) => r.cpuPct)), 0)}–${round(Math.max(...before.map((r) => r.cpuPct)), 0)}`,
        }
      }
      if (cut) {
        likely.unshift('ds-laptop')
        nextStep = `The DS log stops at ${match.when(cut.endTime)}, during the loss: check the DS laptop (plugged in, high-performance power plan, nothing else running) and its Windows Event Viewer for a Driver Station crash.`
      } else if (lostPct !== null && lostPct > 10) {
        likely.push('wireless')
        nextStep = `The DS log shows up to ${lostPct.toFixed(0)} % lost packets in the 3 s before the loss: check where the radio is mounted and ask the FTA about the field's wireless.`
      } else if (lostPct !== null) {
        ruledOut['ds-laptop'] = 'the DS log kept running through the loss'
        nextStep = 'The DS log ran through the loss with no packet loss before it: ask the FTA for the field log for this match.'
      } else {
        nextStep = 'The DS log has no records in the seconds before the loss (it may not line up with this match): check its file is from this match, and ask the FTA for the field log.'
      }
    }

    return {
      message: `Lost comms ${losses.length} time${losses.length === 1 ? '' : 's'}, first at ${match.when(losses[0])}`,
      at: losses[0],
      evidence: {
        losses: losses.length,
        'loss times': losses.map((t) => match.when(t)).join('; '),
        'seconds with outputs off after each': deadSeconds.map((d) => (Number.isFinite(d) ? d.toFixed(1) : '?')).join(', '),
        'lowest battery voltage in the 0.5 s before each (V)': battery ? losses.map((t) => battery.lowest(match.before(t, 0.5)).value.toFixed(2)).join(', ') : 'not logged',
        'roboRIO could reach the radio': match.has(RADIO) ? (radioLost ? 'no, it lost the radio during the match' : 'yes, the whole match') : 'not logged',
        'DS log loaded': match.dsLogs.length ? 'yes' : 'no',
        ...dsBefore,
      },
      measured: [{ label: 'comms losses', value: losses.length, unit: '' }],
      likely, ruledOut, nextStep,
      plot: [match.signal('dsAttached', 'DS attached'), ...(match.has('systemActive') ? [match.signal('systemActive', 'Outputs enabled')] : [])],
      plotFrom: losses[0] - 5, plotTo: losses[losses.length - 1] + 10, plotMarks: losses,
    }
  },
})
