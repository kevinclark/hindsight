/**
 * Board lines and event notes as they are written: stamped (a per-device seq and a `when` that cannot sort before what the
 * device has seen), typed, and never carrying a name. Pure: the history, the device, the role and `now` come in; the caller
 * appends what comes back (App.svelte keep()).
 */
import type { Session } from '../session/session.ts'
import { boardStamp, type BoardEvent, type BoardOp, type BoardRole, type BoardUntil, type EventNote, type EventNoteKind, type HistoryEvent } from '../triage/history.ts'
import { matchRef } from '../triage/track-record.ts'
import { lastOnField } from './points.ts'
import type { BoardIssue } from './model.ts'

export interface Who { device: string; role: BoardRole }

/** One change to one issue. */
export interface Change { op: BoardOp; value: string; until?: BoardUntil }

/** The match a change is made on: the session's latest on-field match, as the other history lines name a match. */
export function atLatest(session: Pick<Session, 'matches'>): { match?: string; event?: string; played?: string } {
  const m = lastOnField(session)
  if (!m) return {}
  const ref = matchRef(m, m.playedAt)
  return { match: ref.id, ...(ref.event ? { event: ref.event } : {}), ...(ref.played !== null ? { played: new Date(ref.played).toISOString() } : {}) }
}

/** The lines for a set of changes to one issue, stamped in order so they fold in order (one `when`, rising seq). */
export function boardLines(history: HistoryEvent[], who: Who, now: Date, issue: Pick<BoardIssue, 'key' | 'robot'>, changes: Change[], at: ReturnType<typeof atLatest>): BoardEvent[] {
  const made: BoardEvent[] = []
  for (const c of changes) {
    const stamp = boardStamp([...history, ...made], who.device, now)
    made.push({ type: 'board', v: 1, key: issue.key, robot: issue.robot, op: c.op, value: c.value, ...(c.until ? { until: c.until } : {}), ...at, by: { device: who.device, role: who.role }, ...stamp })
  }
  return made
}

/** An event-note line (what we changed in the pit, missed by Hindsight, a handoff read). */
export function noteLine(history: HistoryEvent[], who: Who, now: Date, kind: EventNoteKind, event: string, match: string, text: string): EventNote {
  return { type: 'event-note', v: 1, kind, event, match, text, by: { device: who.device, role: who.role }, ...boardStamp(history, who.device, now) }
}

/** Defer an issue: the workaround line first (it is required: written for the pit crew to relay), then the deferral. */
export function deferChanges(workaround: string, until: BoardUntil): Change[] {
  return [{ op: 'workaround', value: workaround.trim() }, { op: 'defer', value: until.kind, until }]
}

/** The grey row's "Close": status `check`, so it closes (derived) after the next clean match. */
export const greyClose = (): Change[] => [{ op: 'status', value: 'check' }]

/** The grey row's "Give it an owner": status `open` plus a note recording the role who took it, so the row has a board change and leaves grey. */
export const greyTake = (role: BoardRole): Change[] => [{ op: 'status', value: 'open' }, { op: 'note', value: `Taken by ${role}` }]
