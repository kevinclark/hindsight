/**
 * Did the robot lose its connection to the Driver Station during the match?
 *
 * Checks: /SystemStats/CommsDisableCount going up, or DSAttached going false, during the match, and how long the
 * outputs stayed off after each.
 * Severity: error. A blip (outputs back on in under 0.5 s) is only info, or a warning from 3 blips; any longer loss,
 * or one whose length is unknown, stays an error.
 * Why: CalGames 2026 Q13 lost comms twice in the last 16 s (7.4 s and 4.3 s dead); the DS log stopped mid-match.
 *
 * Which cause it points to, from this log: the radio rebooted if the roboRIO lost the radio too, or the outputs
 * stayed off for 15 s or more (a radio boots in 20–40 s); a DS log that stops during the loss points to the DS laptop;
 * lost packets or a long trip time in the DS log just before point to the wireless link.
 */
import { isFalse, plural, rule, round, type Severity } from '../rule.ts'
import type { MatchView } from '../view.ts'

const RADIO = '/RadioStatus/Connected' // AdvantageKit's radio logger: can the roboRIO reach the radio?
const RADIO_REBOOT_SECONDS = 15
const BLIP_SECONDS = 0.5 // a loss whose outputs came back on in less than this is a blip
const MANY_BLIPS = 3 // this many blips and nothing longer: a warning, not just a note

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
    const losses = commsLosses(match)
    if (losses.length === 0) return
    // Extra evidence, each optional: how long the outputs stayed off, the battery, the radio, the DS log.
    const backOn = match.signalIfLogged('systemActive')?.turnsOn() ?? []
    const deadSeconds = losses.map((t) => (backOn.find((on) => on > t) ?? NaN) - t)
    const battery = match.signalIfLogged('batteryVoltage')
    const radio = match.signalIfLogged(RADIO)
    // The roboRIO losing the radio around a loss (from 5 s before to 45 s after): the radio went down with it.
    const radioLost = !!radio && losses.some((t) => radio.episodes(isFalse, { touching: match.between(t - 5, t + 45) }).length > 0)
    const ds = match.dsLogs.length ? dsLogsAround(match, losses) : null

    // Which cause this log points to.
    const likely: string[] = []
    const ruledOut: Record<string, string> = {}
    if (radioLost || deadSeconds.some((d) => d >= RADIO_REBOOT_SECONDS)) likely.push('radio')
    else if (radio) ruledOut.radio = 'the roboRIO could reach the radio the whole match'
    if (ds?.points === 'ds-laptop') likely.unshift('ds-laptop') // the DS log stopped during the loss: first suspect
    if (ds?.points === 'wireless') likely.push('wireless')
    if (ds?.points === 'not-ds-laptop') ruledOut['ds-laptop'] = 'the DS log kept running through the loss'

    // Every loss a blip (outputs back on in under 0.5 s)? Then one or two are a note, three or more a warning.
    const allBlips = deadSeconds.every((d) => d < BLIP_SECONDS) // NaN (not logged) is not a blip
    let severity: Severity | undefined
    if (allBlips) severity = losses.length >= MANY_BLIPS ? 'warning' : 'info'

    const longest = Math.max(...deadSeconds)
    const within = longest < 0.05 ? 'under 0.1 s' : `within ${longest.toFixed(1)} s`
    let lostWords = `Lost comms ${plural(losses.length, 'time')}`
    if (allBlips && losses.length === 1) lostWords = `Comms blipped (outputs back on ${within})`
    else if (allBlips) lostWords += `, all blips (outputs back on ${within})`
    const first = losses.length === 1 ? '' : 'first '

    let radioReach = 'not logged'
    if (radio) radioReach = radioLost ? 'no, it lost the radio during the match' : 'yes, the whole match'
    return {
      message: `${lostWords}, ${first}${match.whenAt(losses[0])}`,
      severity,
      at: losses[0],
      likely, ruledOut, nextStep: ds?.nextStep,
      evidence: {
        losses: losses.length,
        'loss times': losses.map((t) => match.when(t)).join('; '),
        'seconds with outputs off after each': deadSeconds.map((d) => (Number.isFinite(d) ? d.toFixed(1) : '?')).join(', '),
        'lowest battery voltage in the 0.5 s before each (V)': battery ? losses.map((t) => battery.lowest(match.before(t, 0.5)).value.toFixed(2)).join(', ') : 'not logged',
        'roboRIO could reach the radio': radioReach,
        'DS log loaded': ds ? 'yes' : 'no',
        ...ds?.evidence,
      },
      measured: [{ label: 'comms losses', value: losses.length, unit: '' }],
      plot: {
        signals: [match.signal('dsAttached', 'DS attached'), ...(match.has('systemActive') ? [match.signal('systemActive', 'Outputs enabled')] : [])],
        from: losses[0] - 5, to: losses[losses.length - 1] + 10, marks: losses,
      },
    }
  },
})

/** When comms were lost during the match: the disable count going up, or the DS detaching (unless it is the same loss seen a few seconds later). */
function commsLosses(match: MatchView): number[] {
  const losses = match.signal('commsDisableCount').increases(match.wholeMatch)
  for (const e of match.signal('dsAttached').episodes(isFalse)) {
    const sameLoss = losses.some((t) => Math.abs(t - e.start) < 10)
    if (match.inMatch(e.start) && !sameLoss) losses.push(e.start)
  }
  return losses.sort((a, b) => a - b)
}

/** The cause a DS log points to: the laptop, the wireless link, not the laptop, or nothing either way. */
type DsCause = 'ds-laptop' | 'wireless' | 'not-ds-laptop' | null

/**
 * What the loaded DS logs say: whether one stops during a loss (the DS app closed or crashed), and the 3 s before the
 * first loss (lost packets, trip time, laptop CPU). `points` is the cause that follows, with its next step.
 */
function dsLogsAround(match: MatchView, losses: number[]): { evidence: Record<string, number | string>; points: DsCause; nextStep: string } {
  const first = losses[0]
  const cut = match.dsLogs.find((d) => losses.some((t) => d.endTime > t - 1 && d.endTime < t + 15))
  const offset = match.epochOffset
  const records = match.dsLogs.flatMap((d) => d.file.records)
  const before = offset === null ? [] : records.filter((r) => r.epochSeconds - offset > first - 3 && r.epochSeconds - offset < first)
  const lostPct = before.length ? Math.max(...before.map((r) => r.lostPacketsPct)) : null
  const cpu = before.map((r) => r.cpuPct)
  const evidence: Record<string, number | string> = lostPct === null ? {} : {
    'DS log, 3 s before the first loss: lost packets (%)': round(lostPct, 0),
    'DS log, 3 s before the first loss: trip time (ms)': round(Math.max(...before.map((r) => r.tripTimeMs)), 1),
    'DS log, 3 s before the first loss: DS laptop CPU (%)': `${round(Math.min(...cpu), 0)}–${round(Math.max(...cpu), 0)}`,
  }
  if (cut) {
    return { evidence, points: 'ds-laptop', nextStep: `The DS log stops ${match.whenAt(cut.endTime)}, during the loss: check the DS laptop (plugged in, high-performance power plan, nothing else running) and its Windows Event Viewer for a Driver Station crash.` }
  }
  if (lostPct !== null && lostPct > 10) {
    return { evidence, points: 'wireless', nextStep: `The DS log shows up to ${lostPct.toFixed(0)} % lost packets in the 3 s before the loss: check where the radio is mounted and ask the FTA about the field's wireless.` }
  }
  if (lostPct !== null) {
    return { evidence, points: 'not-ds-laptop', nextStep: 'The DS log ran through the loss with no packet loss before it: ask the FTA for the field log for this match.' }
  }
  return { evidence, points: null, nextStep: 'The DS log has no records in the seconds before the loss (it may not line up with this match): check its file is from this match, and ask the FTA for the field log.' }
}
