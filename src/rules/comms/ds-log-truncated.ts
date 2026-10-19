/**
 * Did the Driver Station log stop before the match ended?
 *
 * Checks: each .dslog loaded for this match, against the end of the match. A .dslog ends when the DS application
 * closes, so one that stops mid-match means the DS app crashed or was closed.
 * Why: CalGames 2026 Q13: the DS log ended at 420.5 s, 3 s into the first comms loss; the match ran to 433 s.
 */
import { rule, round } from '../rule.ts'

export default rule({
  id: 'comms/ds-log-truncated',
  title: 'Driver Station log ends mid-match',
  severity: 'error',
  who: ['drive'],
  meaning: 'The Driver Station app stopped logging while the match was still running: it crashed, was closed, or the laptop slept.',
  causes: [
    { id: 'app-crash', cause: 'The Driver Station app crashed', look: 'Windows Event Viewer on the DS laptop (Application log) at that time' },
    { id: 'laptop-power', cause: 'The laptop slept or throttled (on battery, power-saving plan)', look: 'was the laptop plugged in? Its power plan (should be High performance)' },
    { id: 'overload', cause: 'Something else on the laptop starved the DS (dashboards, updates, browsers)', look: 'Task Manager during a practice match; the DS log\'s CPU column before it stopped' },
  ],
  nextStep: 'Plug the DS laptop in, set the High performance power plan, close everything but the DS and dashboard, and check Event Viewer for a Driver Station crash.',
  incident: 'CalGames 2026 Q13: DS log ends at 420.5 s; match ran to 433.1 s (2026-10-17-calgames-q13-log-analysis.md §2)',

  check(match) {
    if (match.dsLogs.length === 0) return match.couldNotCheck('no .dslog loaded for this match (drop the .dslog together with the .wpilog)')
    if (match.autoStart === null || match.matchEnd === null) return
    const end = match.matchEnd
    // Every DS log that stops inside the match counts, including the first of two when the DS app restarted.
    const cut = match.dsLogs.filter((d) => d.endTime > match.autoStart! && d.endTime < end - 1)
    return cut.map((d) => {
      // The DS's last record with a robot voltage: when the DS last heard from the robot.
      const lastHeard = [...d.file.records].reverse().find((r) => r.voltage !== null)
      return {
        message: `Driver Station log ends at ${match.when(d.endTime)}, ${(end - d.endTime).toFixed(1)} s before the match ended`,
        at: d.endTime,
        evidence: {
          'DS log ends': match.when(d.endTime),
          'match ends': match.when(end - 0.001),
          'DS last saw the robot': lastHeard && match.epochOffset !== null ? match.when(lastHeard.epochSeconds - match.epochOffset) : 'never',
          'DS log file': d.fileName,
          'DS logs for this match': match.dsLogs.length,
        },
        measured: [{ label: 'DS log ended before the match did', value: round(end - d.endTime, 1), unit: 's', threshold: 1 }],
      }
    })
  },
})
