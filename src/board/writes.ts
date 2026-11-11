/**
 * Board lines and event notes as they are written: stamped (a per-device seq and a `when` that cannot sort before what the
 * device has seen), typed, and never carrying a name. Pure: the history, the device, the role and `now` come in; the caller
 * appends what comes back (App.svelte keep()).
 */
import type { Session } from '../session/session.ts'
import { boardStamp, type BoardEvent, type BoardOp, type BoardRole, type BoardUntil, type CauseState, type EventNote, type EventNoteKind, type HistoryEvent } from '../triage/history.ts'
import { matchRef } from '../triage/track-record.ts'
import { lastOnField } from './points.ts'
import { OWNER_ROLES } from './role.ts'
import { TO_BOARD, type BoardIssue, type Priority } from './model.ts'

export interface Who { device: string; role: BoardRole }

/** One change to one issue. */
export interface Change { op: BoardOp; value: string; until?: BoardUntil; cause?: string; test?: string; text?: string }

/** The match a change is made on: the session's latest on-field match, as the other history lines name a match. */
export function atLatest(session: Pick<Session, 'matches'>): { match?: string; event?: string; played?: string } {
  const m = lastOnField(session)
  if (!m) return {}
  const ref = matchRef(m, m.playedAt)
  return { match: ref.id, ...(ref.event ? { event: ref.event } : {}), ...(ref.played !== null ? { played: new Date(ref.played).toISOString() } : {}) }
}

/**
 * The lines for a set of changes to one issue, stamped in order so they fold in order (one `when`, rising seq). On a group row
 * (model.ts BoardGroup) they are the same lines for each open member, stamped against the lines already made so every seq is new;
 * a note or a cause mark is about one device, so a group refuses it.
 */
export function boardLines(history: HistoryEvent[], who: Who, now: Date, issue: Pick<BoardIssue, 'key' | 'robot' | 'group'>, changes: Change[], at: ReturnType<typeof atLatest>): BoardEvent[] {
  const made: BoardEvent[] = []
  if (issue.group) {
    const one = changes.find((c) => c.op === 'note' || c.op === 'cause')
    if (one) throw new Error(`A ${one.op} is per member: write it on one device's issue, not on the group`)
    for (const m of issue.group.open) made.push(...boardLines([...history, ...made], who, now, m, changes, at))
    return made
  }
  for (const c of changes) {
    const stamp = boardStamp([...history, ...made], who.device, now)
    made.push({ type: 'board', v: 1, key: issue.key, robot: issue.robot, op: c.op, value: c.value, ...(c.until ? { until: c.until } : {}), ...(c.cause ? { cause: c.cause, ...(c.test ? { test: c.test } : {}), text: c.text ?? '' } : {}), ...at, by: { device: who.device, role: who.role }, ...stamp })
  }
  return made
}

/** The issue screen's three plain fields as the form holds them. */
export interface Fields { priority: Priority; status: 'open' | 'fixing' | 'check'; owner: string }

/**
 * The changes a Save makes from the priority, status and owner fields. A field is written when it differs from what the
 * screen showed; on a group whose members disagree on it ("mixed"), also when the person used that control, since the value
 * shown is not what each member has. A field nobody touched is never written (a group of red devices and amber alerts is
 * mixed on priority from the start: a Save of the owner alone must not make the alerts red).
 */
export function fieldChanges(issue: Pick<BoardIssue, 'priority' | 'asked' | 'owner' | 'status' | 'group'>, form: Fields, touched: Partial<Record<keyof Fields, boolean>>): Change[] {
  const mixed = issue.group?.mixed
  const out: Change[] = []
  if (form.priority !== issue.priority || (mixed?.priority && touched.priority)) out.push({ op: 'priority', value: TO_BOARD[form.priority] })
  if (issue.status !== 'deferred' && (form.status !== issue.asked || (mixed?.status && touched.status))) out.push({ op: 'status', value: form.status })
  if (form.owner !== (issue.owner ?? '') || (mixed?.owner && touched.owner)) out.push({ op: 'owner', value: form.owner })
  return out
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

/** The grey row's "Give it an owner": back to Open with a role on it. Status `open`, the owner when the role can own (a mentor coaches: the note only), then a note recording who took it. Any of them is a board change, so the row leaves grey. */
export const greyTake = (role: BoardRole): Change[] => [
  { op: 'status', value: 'open' },
  ...((OWNER_ROLES as readonly string[]).includes(role) ? [{ op: 'owner' as const, value: role }] : []),
  { op: 'note', value: `Taken by ${role}` },
]

/** The debug workspace's record of one cause: its state; for ruled-out the test and, apart, what it showed (`text`); for the other states a note in `text`. */
export const causeChange = (cause: string, state: CauseState, text: string, test = ''): Change[] => [{ op: 'cause', value: state, cause, ...(state === 'ruled-out' && test.trim() ? { test: test.trim() } : {}), text: text.trim() }]
