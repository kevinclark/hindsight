/**
 * alerts/passthrough — show every Alert the robot code raised, so none is silent.
 *
 * Checks: every text in each AdvantageKit Alert group (errors, warnings, infos). Alerts active during the match
 * keep the programmers' severity (error → red, warning → amber, info → grey); alerts seen only before or after the
 * match are listed once, in grey.
 * Why: CalGames 2026 P0 raised "Flywheel Follower Disconnected" 7 times and nobody saw it until the log review.
 * When it fires: read the alert; the programmer who wrote it knows what it means.
 */
import { values, type Match } from '../../match/match.ts'
import { inMatch } from '../helpers.ts'
import type { Finding, Rule, Severity } from '../types.ts'

const KINDS: { kind: string; severity: Severity }[] = [
  { kind: 'errors', severity: 'error' }, { kind: 'warnings', severity: 'warning' }, { kind: 'infos', severity: 'info' },
]

interface Seen { severity: Severity; group: string; onsets: number[]; seconds: number; duringMatch: boolean }

export const passthrough: Rule = {
  id: 'alerts/passthrough',
  title: 'Robot code alerts',
  fix: 'Read the alert text; ask whoever wrote that alert what it means and what to check.',
  incident: 'CalGames 2026 P0: "Flywheel Follower Disconnected" ×7, unseen during the match (hindsight-research/design-detail.md §5a)',
  needs: (m: Match) => m.profile.signals.alertGroups.slice(0, 1).map((g) => `${g}/errors`),
  run(m: Match): Finding[] {
    const seen = new Map<string, Seen>()
    for (const group of m.profile.signals.alertGroups) {
      for (const { kind, severity } of KINDS) {
        const a = values<string[]>(m, `${group}/${kind}`)
        if (!a) continue
        for (let i = 0; i < a.t.length; i++) {
          const until = i + 1 < a.t.length ? a.t[i + 1] : m.logEnd
          const before = new Set(i > 0 ? a.v[i - 1] : [])
          for (const text of a.v[i]) {
            const s = seen.get(text) ?? { severity, group: group.split('/').pop()!, onsets: [], seconds: 0, duringMatch: false }
            if (!before.has(text)) s.onsets.push(a.t[i])
            s.seconds += until - a.t[i]
            s.duringMatch ||= inMatch(m, a.t[i]) || (m.matchStart !== null && a.t[i] < m.matchStart && until > m.matchStart)
            seen.set(text, s)
          }
        }
      }
    }
    const out: Finding[] = []
    const outside: string[] = []
    for (const [text, s] of seen) {
      const short = text.replace(/It's been .*$/, '').trim()
      if (!s.duringMatch) { outside.push(`${short} (${s.onsets.length}×)`); continue }
      out.push({
        rule: this.id,
        severity: s.severity,
        title: `Alert "${short}" ${s.onsets.length}× during the match`,
        time: s.onsets.find((t) => inMatch(m, t)) ?? s.onsets[0],
        evidence: { group: s.group, times: s.onsets.length, 'onsets (s)': s.onsets.slice(0, 12).map((t) => t.toFixed(1)).join(', '), 'seconds active': +s.seconds.toFixed(1) },
      })
    }
    if (outside.length) {
      out.push({
        rule: this.id, severity: 'info', time: null,
        title: `${outside.length} alert${outside.length === 1 ? '' : 's'} only before or after the match`,
        evidence: Object.fromEntries(outside.map((x, i) => [`alert ${i + 1}`, x])),
      })
    }
    return out
  },
}
