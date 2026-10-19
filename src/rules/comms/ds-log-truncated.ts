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
  fix: 'Treat the DS laptop as the suspect: plugged in, high-performance power plan, nothing else running, check its event log for an app crash.',
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
        message: `Driver Station log ends at ${d.endTime.toFixed(1)} s, ${(end - d.endTime).toFixed(1)} s before the match ended`,
        at: d.endTime,
        evidence: {
          'DS log ends (s)': round(d.endTime),
          'match ends (s)': round(end),
          'DS last saw the robot (s)': lastHeard && match.epochOffset !== null ? round(lastHeard.epochSeconds - match.epochOffset) : 'never',
          'DS log file': d.fileName,
          'DS logs for this match': match.dsLogs.length,
        },
      }
    })
  },
})
