/**
 * Did the Driver Station log stop before the match ended?
 *
 * Checks: each .dslog loaded for this match, against the end of the match. A .dslog ends when the DS application
 * closes, so one that stops mid-match means the DS app crashed or was closed.
 * Why: One 2026 match: the DS log ended at 420.5 s, 3 s into the first comms loss; the match ran to 433 s.
 */
import { rule, round, secs } from '../rule.ts'
import { WPILIB_DS_BEST_PRACTICES, WPILIB_DS_LOG_VIEWER } from '../sources.ts'

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
  incident: 'One 2026 match: DS log ends at 420.5 s; match ran to 433.1 s',
  sources: [
    { ...WPILIB_DS_LOG_VIEWER, says: 'An FMS disconnect splits the Driver Station log in two; the first log ends with a bad FMS connection event, usually from an Ethernet cable without a latching tab or a damaged port.' },
    { ...WPILIB_DS_BEST_PRACTICES, says: 'Settings that keep the Driver Station laptop from sleeping or throttling during a match.' },
  ],
  thresholds: [
    { name: 'log ends before the match', value: 'more than 1 s early', basis: 'judgment', how: 'Chosen.' },
  ],

  check(match) {
    if (match.dsLogs.length === 0) return match.couldNotCheck('no .dslog loaded for this match (drop the .dslog together with the .wpilog)')
    const { autoStart, matchEnd } = match
    if (autoStart === null || matchEnd === null) return match.couldNotCheck('no match in this log')

    // Every DS log that stops inside the match counts, including the first of two when the DS app restarted.
    const cutLogs = match.dsLogs.filter((log) => log.endTime > autoStart && log.endTime < matchEnd - 1)
    return cutLogs.map((log) => {
      const secondsEarly = matchEnd - log.endTime
      // The DS's last record with a robot voltage: when the DS last heard from the robot.
      const lastHeard = [...log.file.records].reverse().find((r) => r.voltage !== null)
      const lastSaw = lastHeard && match.epochOffset !== null ? match.when(lastHeard.epochSeconds - match.epochOffset) : 'never'
      return {
        message: `Driver Station log ends ${match.whenAt(log.endTime)}, ${secs(secondsEarly)} before the match ended`,
        at: log.endTime,
        evidence: {
          'DS log ends': match.when(log.endTime),
          'match ends': match.when(matchEnd - 0.001),
          'DS last saw the robot': lastSaw,
          'DS log file': log.fileName,
          'DS logs for this match': match.dsLogs.length,
        },
        measured: [{ label: 'DS log ended before the match did', value: round(secondsEarly, 1), unit: 's', threshold: 1 }],
      }
    })
  },
})
