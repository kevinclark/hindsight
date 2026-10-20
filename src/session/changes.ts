/**
 * What changed in a session's findings after "Read again": new ones, gone ones, and ones whose confidence or
 * "fired in k of n" changed. Pure: the page takes a snapshot before reading and compares it with the one after.
 */
import { CONFIDENCE_WORDS, type Confidence, type MergedFinding } from './session.ts'

export interface FindingSnapshot {
  key: string
  severity: 'error' | 'warning' | 'info'
  title: string
  confidence: Confidence
  /** Matches it fired in, and matches where it could be checked. */
  fired: number
  checkable: number
}

/** How a finding stood: its confidence and "fired in k of n". */
export interface Standing { confidence: Confidence; fired: number; checkable: number }

export interface FindingChange {
  key: string
  severity: 'error' | 'warning' | 'info'
  title: string
  kind: 'new' | 'gone' | 'changed'
  /** Absent for a new finding. */
  before?: Standing
  /** Absent for a gone finding. */
  after?: Standing
}

/** The part of a session's merged findings that is compared. */
export function snapshotFindings(merged: MergedFinding[]): FindingSnapshot[] {
  return merged.map((f) => ({
    key: f.key, severity: f.severity, title: f.title,
    confidence: f.confidence, fired: f.matches.length, checkable: f.checkable,
  }))
}

const standing = (f: FindingSnapshot): Standing => ({ confidence: f.confidence, fired: f.fired, checkable: f.checkable })

/** Findings that are new, gone, or have another confidence or "fired in k of n"; worst severity first. */
export function diffFindings(before: FindingSnapshot[], after: FindingSnapshot[]): FindingChange[] {
  const was = new Map(before.map((f) => [f.key, f]))
  const now = new Map(after.map((f) => [f.key, f]))
  const changes: FindingChange[] = []
  for (const f of after) {
    const old = was.get(f.key)
    if (!old) changes.push({ key: f.key, severity: f.severity, title: f.title, kind: 'new', after: standing(f) })
    else if (old.confidence !== f.confidence || old.fired !== f.fired || old.checkable !== f.checkable) {
      changes.push({ key: f.key, severity: f.severity, title: f.title, kind: 'changed', before: standing(old), after: standing(f) })
    }
  }
  for (const f of before) {
    if (!now.has(f.key)) changes.push({ key: f.key, severity: f.severity, title: f.title, kind: 'gone', before: standing(f) })
  }
  const worst = { error: 0, warning: 1, info: 2 }
  const order = { new: 0, gone: 1, changed: 2 }
  return changes.sort((a, b) => worst[a.severity] - worst[b.severity] || order[a.kind] - order[b.kind] || a.key.localeCompare(b.key))
}

/** "Consistent, 3 of 4" */
export function standingText(s: Standing): string {
  return `${CONFIDENCE_WORDS[s.confidence]}, ${s.fired} of ${s.checkable}`
}

/** One line for a change: "New: …", "Gone: …" or "Changed: … Once, 1 of 4 → Consistent, 3 of 4". */
export function changeText(c: FindingChange): string {
  if (c.kind === 'new' && c.after) return `New: ${c.key} (${standingText(c.after)})`
  if (c.kind === 'gone' && c.before) return `Gone: ${c.key} (was ${standingText(c.before)})`
  if (c.before && c.after) return `Changed: ${c.key} (${standingText(c.before)} → ${standingText(c.after)})`
  return c.key
}
