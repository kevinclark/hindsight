/**
 * "Download for Claude" for a whole session: session-findings.json with the grid, the confidence of each finding and
 * the per-match numbers. Like findings.json, it never holds raw series or the radio status.
 */
import { VERSION } from '../version.ts'
import { mergeFindings, ruleGrid, type MergedFinding, type Session } from './session.ts'
import type { FindingChange } from './changes.ts'
import type { IssueEvent } from '../triage/history.ts'
import { sinks, stoppedFiring, stoppedText, type Stopped } from './stopped.ts'

export const SESSION_FINDINGS_SCHEMA = 'hindsight.session-findings/1'

/** Pass the session as the team's marks show it (triage/track-record.ts sessionWithMarks): findings then carry `wrong` and `demoted`. */
export function buildSessionJson(session: Session, issues: Map<string, IssueEvent> = new Map(), typedBatteries: Record<string, string> = {}, changedOnReread?: FindingChange[]): object {
  return {
    schema: SESSION_FINDINGS_SCHEMA,
    tool: { name: 'hindsight', version: VERSION },
    generatedAt: new Date().toISOString(),
    session: { label: session.label, kind: session.kind },
    matches: session.matches.map((m) => ({
      file: m.fileName, ...(m.pieces ? { pieces: m.pieces } : {}), robot: m.robot, playedAt: m.playedAt === null ? null : new Date(m.playedAt).toISOString(), playedAtSource: m.playedAtSource,
      clockNote: m.clockNote, event: m.event, match: m.matchLabel, onField: m.onField,
      battery: m.batteryId ?? typedBatteries[m.fileName] ?? null, batterySource: m.batteryId ? 'logged' : typedBatteries[m.fileName] ? 'typed' : null,
      build: m.build ?? null, metrics: m.metrics,
    })),
    grid: ruleGrid(session).map((r) => ({ rule: r.rule, cells: r.cells, fired: r.fired, checkable: r.checkable, confidence: r.confidence, wilson95: r.interval })),
    findings: mergeFindings(session).map((f) => ({
      ...f,
      matches: f.matches.map((i) => session.matches[i].fileName),
      ...(f.wrong ? { wrong: f.wrong.map((w) => ({ match: session.matches[w.match].fileName, note: w.reason, since: w.when })) } : {}),
      issue: issues.get(f.key) ? { status: issues.get(f.key)!.status, note: issues.get(f.key)!.note, since: issues.get(f.key)!.when } : null,
      ...stoppedJson(session, f.severity, stoppedFiring(session, f, issues.get(f.key))),
    })),
    // Only after "Read again": what that changed in the findings (additive; the schema id stays /1).
    ...(changedOnReread ? { changedOnReread: { hindsightVersion: VERSION, changes: changedOnReread } } : {}),
  }
}

/**
 * Whether the finding stopped firing (session/stopped.ts), with the line the view shows. Only when it did, so the
 * file is unchanged otherwise. Matches by file name, like the rest of this file.
 */
function stoppedJson(session: Session, severity: MergedFinding['severity'], s: Stopped | null): object {
  if (!s) return {}
  const file = (i: number | null) => (i === null ? null : session.matches[i].fileName)
  const text = stoppedText(session, s)
  const codeChanged = s.codeChanged ?? null
  if (s.kind === 'fixed mark') return { stopped: { kind: s.kind, markedAfter: file(s.before), quietSince: s.quiet, codeChanged, text } }
  return {
    stopped: {
      kind: s.kind, lastFired: file(s.last), cleanAfter: s.clean,
      chance: { times: s.times, outOf: s.outOf, value: s.chance }, potentiallyFixed: s.potentiallyFixed,
      sortsBelowLive: sinks(s, severity), codeChanged, text,
    },
  }
}
