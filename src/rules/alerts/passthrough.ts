/**
 * alerts/passthrough — show every Alert the robot code raised, so none is silent.
 *
 * Checks: every text in each AdvantageKit Alert group (errors, warnings, infos). Alerts that came on during the
 * match keep the programmers' severity (error → red, warning → amber, info → grey), counted and timed inside the
 * match only. Alerts seen only before or after the match are listed once, in grey. Texts another rule already
 * explains (vision/time-sync) are left to that rule.
 * Why: CalGames 2026 P0 raised "Flywheel Follower Disconnected" 7 times and nobody saw it until the log review.
 * When it fires: read the alert; the programmer who wrote it knows what it means.
 */
import { values, type Match } from '../../match/match.ts'
import { inMatch } from '../helpers.ts'
import { TIME_SYNC_PATTERNS } from '../vision/time-sync.ts'
import type { Finding, Rule, Severity } from '../types.ts'

const KINDS: { kind: string; severity: Severity }[] = [
  { kind: 'errors', severity: 'error' }, { kind: 'warnings', severity: 'warning' }, { kind: 'infos', severity: 'info' },
]

/** One alert text: its severity and group, and when it came on (inside and outside the match). */
interface Seen { severity: Severity; group: string; inMatch: number[]; outside: number; secondsInMatch: number }

export const passthrough: Rule = {
  id: 'alerts/passthrough',
  title: 'Robot code alerts',
  audience: ['software'],
  fix: 'Read the alert text; ask whoever wrote that alert what it means and what to check.',
  incident: 'CalGames 2026 P0: "Flywheel Follower Disconnected" ×7, unseen during the match (hindsight-research/design-detail.md §5a)',
  needs: (m: Match) => m.profile.signals.alertGroups.slice(0, 1).map((g) => `${g}/errors`),
  run(m: Match): Finding[] {
    const seen = new Map<string, Seen>()
    const start = m.matchStart ?? Infinity
    const end = m.matchEnd ?? -Infinity
    for (const group of m.profile.signals.alertGroups) {
      for (const { kind, severity } of KINDS) {
        const a = values<string[]>(m, `${group}/${kind}`)
        if (!a) continue
        for (let i = 0; i < a.t.length; i++) {
          const until = i + 1 < a.t.length ? a.t[i + 1] : m.logEnd
          const before = new Set(i > 0 ? a.v[i - 1] : [])
          for (const text of a.v[i]) {
            if (TIME_SYNC_PATTERNS.some((p) => p.test(text))) continue
            const s = seen.get(text) ?? { severity, group: group.split('/').pop()!, inMatch: [], outside: 0, secondsInMatch: 0 }
            if (!before.has(text)) { if (inMatch(m, a.t[i])) s.inMatch.push(a.t[i]); else s.outside++ }
            s.secondsInMatch += Math.max(0, Math.min(until, end) - Math.max(a.t[i], start))
            seen.set(text, s)
          }
        }
      }
    }
    const out: Finding[] = []
    const outsideOnly: string[] = []
    for (const [text, s] of seen) {
      if (s.inMatch.length === 0) { outsideOnly.push(`${text} (${s.outside}×)`); continue }
      out.push({
        rule: this.id, severity: s.severity, time: s.inMatch[0],
        title: `Alert "${text}" ${s.inMatch.length}× during the match`,
        evidence: { group: s.group, 'times during the match': s.inMatch.length, 'onsets (s)': s.inMatch.slice(0, 12).map((t) => t.toFixed(1)).join(', '), 'seconds active during the match': +s.secondsInMatch.toFixed(1), 'times before or after the match': s.outside },
      })
    }
    if (outsideOnly.length) {
      out.push({
        rule: this.id, severity: 'info', time: null,
        title: `${outsideOnly.length} alert${outsideOnly.length === 1 ? '' : 's'} only before or after the match`,
        evidence: Object.fromEntries(outsideOnly.map((x, i) => [`alert ${i + 1}`, x])),
      })
    }
    return out
  },
}
