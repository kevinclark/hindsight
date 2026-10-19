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
  fix: 'Treat the DS laptop as the suspect: plugged in, high-performance power plan, nothing else running, check its event log for an app crash.',
  incident: 'CalGames 2026 Q13: DS log ends at 420.5 s; match ran to 433.1 s (2026-10-17-calgames-q13-log-analysis.md §2)',
  needs: () => [],
  run(m: Match): Finding[] | NotChecked {
    if (!m.ds) return { notChecked: 'no .dslog loaded for this match (drop the .dslog together with the .wpilog)' }
    if (m.matchEnd === null) return { notChecked: 'the robot was never enabled' }
    const lastRobot = [...m.ds.file.records].reverse().find((r) => r.voltage !== null)
    if (m.ds.endTime >= m.matchEnd - SLACK_SECONDS) return []
    return [{
      rule: this.id,
      severity: 'error',
      title: `Driver Station log ends at ${m.ds.endTime.toFixed(1)} s, ${(m.matchEnd - m.ds.endTime).toFixed(1)} s before the match ended`,
      time: m.ds.endTime,
      evidence: {
        'DS log ends (s)': +m.ds.endTime.toFixed(2),
        'match ends (s)': +m.matchEnd.toFixed(2),
        'DS last saw the robot (s)': lastRobot && m.epochOffset !== null ? +(lastRobot.epochSeconds - m.epochOffset).toFixed(2) : 'never',
        'DS log file': m.ds.fileName,
      },
    }]
  },
}
