/**
 * comms/ds-log-truncated — did the Driver Station log stop before the match ended?
 *
 * Checks: the end of the .dslog against the end of the match (both on the wall clock). A .dslog ends when the DS
 * application closes, so a log that stops mid-match means the DS app crashed or was closed.
 * Why: CalGames 2026 Q13: the DS log ended at 420.5 s, 3 s into the first comms loss, while the match ran to 433 s.
 * When it fires: the DS laptop is the suspect. Check its power plan, CPU load (80–90 % in Q13), and Windows event log.
 */
import type { Match } from '../../match/match.ts'
import type { Finding, NotChecked, Rule } from '../types.ts'

const SLACK_SECONDS = 1

export const dsLogTruncated: Rule = {
  id: 'comms/ds-log-truncated',
  title: 'Driver Station log ends mid-match',
  audience: ['drive'],
  fix: 'Treat the DS laptop as the suspect: plugged in, high-performance power plan, nothing else running, check its event log for an app crash.',
  incident: 'CalGames 2026 Q13: DS log ends at 420.5 s; match ran to 433.1 s (2026-10-17-calgames-q13-log-analysis.md §2)',
  needs: () => [],
  run(m: Match): Finding[] | NotChecked {
    if (m.ds.length === 0) return { notChecked: 'no .dslog loaded for this match (drop the .dslog together with the .wpilog)' }
    if (m.matchStart === null || m.matchEnd === null) return { notChecked: 'the robot was never enabled' }
    const matchEnd = m.matchEnd
    // Every DS log that stops inside the match counts, including the first of two when the DS app restarted.
    const cut = m.ds.filter((d) => d.endTime > m.matchStart! && d.endTime < matchEnd - SLACK_SECONDS)
    return cut.map((d) => {
      const lastRobot = [...d.file.records].reverse().find((r) => r.voltage !== null)
      return {
        rule: this.id,
        severity: 'error' as const,
        title: `Driver Station log ends at ${d.endTime.toFixed(1)} s, ${(matchEnd - d.endTime).toFixed(1)} s before the match ended`,
        time: d.endTime,
        evidence: {
          'DS log ends (s)': +d.endTime.toFixed(2),
          'match ends (s)': +matchEnd.toFixed(2),
          'DS last saw the robot (s)': lastRobot && m.epochOffset !== null ? +(lastRobot.epochSeconds - m.epochOffset).toFixed(2) : 'never',
          'DS log file': d.fileName,
          'DS logs for this match': m.ds.length,
        },
      }
    })
  },
}
