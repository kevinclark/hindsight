/**
 * "Download for Claude" for a whole session: session-findings.json with the grid, the confidence of each finding and
 * the per-match numbers. Like findings.json, it never holds raw series or the radio status.
 */
import { VERSION } from '../version.ts'
import { mergeFindings, ruleGrid, type Session } from './session.ts'
import type { IssueEvent } from '../triage/history.ts'

export const SESSION_FINDINGS_SCHEMA = 'hindsight.session-findings/1'

export function buildSessionJson(session: Session, issues: Map<string, IssueEvent> = new Map(), typedBatteries: Record<string, string> = {}): object {
  return {
    schema: SESSION_FINDINGS_SCHEMA,
    tool: { name: 'hindsight', version: VERSION },
    generatedAt: new Date().toISOString(),
    session: { label: session.label, kind: session.kind },
    matches: session.matches.map((m) => ({
      file: m.fileName, playedAt: m.playedAt === null ? null : new Date(m.playedAt).toISOString(), playedAtSource: m.playedAtSource,
      clockNote: m.clockNote, event: m.event, match: m.matchLabel, onField: m.onField,
      battery: m.batteryId ?? typedBatteries[m.fileName] ?? null, batterySource: m.batteryId ? 'logged' : typedBatteries[m.fileName] ? 'typed' : null,
      metrics: m.metrics,
    })),
    grid: ruleGrid(session).map((r) => ({ rule: r.rule, cells: r.cells, fired: r.fired, checkable: r.checkable, confidence: r.confidence, wilson95: r.interval })),
    findings: mergeFindings(session).map((f) => ({
      ...f,
      matches: f.matches.map((i) => session.matches[i].fileName),
      issue: issues.get(f.key) ? { status: issues.get(f.key)!.status, note: issues.get(f.key)!.note, since: issues.get(f.key)!.when } : null,
    })),
  }
}
