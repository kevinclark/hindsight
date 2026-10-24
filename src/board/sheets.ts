/**
 * The two sheets a shift reads: the queue sheet (what to confirm before the next match, printed for the pit crew to pass to
 * the drive team) and the handoff (what the next shift needs to know). Pure models of the board; the screens draw them.
 */
import { makerOf } from '../rules/index.ts'
import type { Board, BoardIssue } from './model.ts'
import { isChecked, isGate } from './model.ts'
import { queueVerdictText } from './words.ts'
import { tickAt } from './ticks.ts'

/** A sheet holds at most this many lines (a tired reader at the field): over it says "n more on the board". */
export const SHEET_LINES = 7

export interface QueueLine {
  kind: 'gate' | 'deferral'
  issue: BoardIssue
  /** Gate lines: the role and time of the tick, once checked and while it is fresh (it goes old after 90 minutes, as Foresight's does). */
  checked: { role: string; when: string } | null
  /** Gate lines: a tick that went old (or is dated after this laptop's clock), shown as "ticked at … (old)"; the red needs a new tick. */
  old: { role: string; when: string; ahead: boolean } | null
}

export interface QueueSheet {
  /** The match this sheet is for ("Q41", or "after Q33" with no schedule): the key a tick is filed under. */
  forMatch: string
  /** The same, for people: "Q41", or "the next match" with no schedule. */
  forLabel: string
  /** When the gate falls due, in words: "before Q41", "before the next match", or "open · the event is over" once no match is left. */
  when: string
  /** The event is over (board.strip.over). */
  over: boolean
  /** NOT CLEARED: n RED(S) TO CONFIRM, or GO WITH n DEFERRAL(S) · m RED(S) OPEN. Never green, never plain GO. */
  verdict: { cleared: boolean; text: string }
  toConfirm: number
  deferrals: number
  redsOpen: number
  gate: number
  lines: QueueLine[]
  /** Items past the line cap. */
  more: number
  /** One line when the latest match has no time and no event name: ticks written now can't be tied to this event, so they never count. Null otherwise. */
  tickNote: string | null
}

/**
 * The gate is the reds due before the next match, each either checked (its role and time recorded) or deferred. The
 * verdict is NOT CLEARED until every gate red is checked or deferred; then it is GO WITH its deferrals and open reds, which
 * says a go still has work open. The sheet lists the gate reds, then every live deferral with its workaround line, at most 7.
 */
export function queueSheet(board: Board): QueueSheet {
  const { tl, tickFor } = board
  const gate = board.rows.filter((i) => isGate(i, tl))
  const deferrals = board.rows.filter((i) => i.status === 'deferred' && i.deferral && !i.deferral.expired)
  const redsOpen = board.rows.filter((i) => i.priority === 'red' && !i.grey && i.status !== 'deferred').length
  const now = board.tl.now
  const toConfirm = gate.filter((i) => !isChecked(i, tickFor, now)).length
  const all: QueueLine[] = [
    ...gate.map((issue): QueueLine => {
      const c = issue.checked.filter((x) => x.match === tickFor).at(-1)
      const t = c && now !== null ? tickAt(c.role, c.when, now) : null
      const stale = !!t?.old
      return { kind: 'gate', issue, checked: c && !stale ? { role: c.role, when: c.when } : null, old: c && t && stale ? { role: c.role, when: c.when, ahead: t.ahead } : null }
    }),
    ...deferrals.map((issue): QueueLine => ({ kind: 'deferral', issue, checked: null, old: null })),
  ]
  const text = queueVerdictText(toConfirm, deferrals.length, redsOpen)
  return {
    forMatch: tickFor, forLabel: board.tickLabel, over: board.strip.over, when: board.strip.over ? 'open · the event is over' : `before ${board.tickLabel}`, verdict: { cleared: toConfirm === 0, text }, toConfirm, deferrals: deferrals.length, redsOpen, gate: gate.length,
    lines: all.slice(0, SHEET_LINES), more: Math.max(0, all.length - SHEET_LINES),
    tickNote: board.untied ? "Ticks here can't be tied to this event: the log has no clock and no event name." : null,
  }
}

/** A cause that is out: by the logs (the rule's own reason on the latest finding, Hindsight's) or by the team (a test the debug workspace recorded, with the role that wrote it). */
export interface RuledOut { issue: BoardIssue; cause: string; why: string; by: 'logs' | 'team'; role?: string }
/** One cause line under an issue in the handoff: ruled out (by Hindsight's evidence or by a team test) or confirmed. */
export interface CauseLine { kind: 'ruled-out' | 'confirmed'; by: 'logs' | 'team'; cause: string; text: string; role?: string }
/** A cause the team confirmed in the debug workspace. */
export interface Confirmed { issue: BoardIssue; cause: string; text: string; role: string }

export interface Handoff {
  /** Reds due before the next match, and deferrals due. */
  redsDue: BoardIssue[]
  deferralsDue: BoardIssue[]
  /** What was tried: every note on those issues, oldest first (by the order the board keeps them), with the match and role. */
  tried: { issue: BoardIssue; text: string; role: string; match: string | null; when: string }[]
  /** Causes the logs ruled out for those issues (the latest finding's own, from Hindsight's evidence). */
  ruledOut: RuledOut[]
  /** Causes the team confirmed for those issues. */
  confirmed: Confirmed[]
  /** Each focus issue's own ruled-out and confirmed lines, by issue key: shown under its row. */
  causeLines: Map<string, CauseLine[]>
  /** First seen after the last handoff was read, the board's own definition. With no handoff on record nothing is new (there is nothing to compare with), here and on the board. */
  newSince: BoardIssue[]
  /** True when no handoff has been read yet at this event. */
  firstRead: boolean
  pitLines: Board['pitLines']
}

/** What the next shift needs: the reds due before the next match, the deferrals due, what was tried (including what was ruled out) and what is new since the last handoff read. */
export function handoff(board: Board): Handoff {
  const redsDue = board.rows.filter((i) => isGate(i, board.tl))
  const deferralsDue = board.rows.filter((i) => i.cls === 'due')
  const focus = [...redsDue, ...deferralsDue, ...board.rows.filter((i) => i.status === 'check')].filter((i, n, a) => a.indexOf(i) === n)
  const nameOf = (issue: BoardIssue, id: string) => makerOf(issue.rule)?.causes.find((c) => c.id === id)?.cause ?? id
  const testText = (m: { test: string; text: string }) => [m.test, m.text].filter(Boolean).join(': ') || 'a test (none written)'
  // What was tried: the notes, and the tests recorded on causes (a ruled-out cause with its test, a confirmed one with its note).
  const tried = focus.flatMap((issue) => [
    ...issue.notes.map((n) => ({ issue, text: n.text, role: n.role, match: n.match, when: n.when })),
    ...Object.entries(issue.causeMarks).filter(([, m]) => m.state !== 'possible').map(([id, m]) => ({ issue, text: m.state === 'ruled-out' ? `${nameOf(issue, id)}: ruled out by ${testText(m)}` : `${nameOf(issue, id)}: confirmed${m.text ? `: ${m.text}` : ''}`, role: m.role, match: m.match, when: m.when })),
  ]).sort((a, b) => a.when.localeCompare(b.when))
  const ruledOut = focus.flatMap((issue): RuledOut[] => [
    ...Object.entries(issue.latest?.ruledOut ?? {}).map(([id, why]): RuledOut => ({ issue, cause: nameOf(issue, id), why, by: 'logs' })),
    ...Object.entries(issue.causeMarks).filter(([, m]) => m.state === 'ruled-out').map(([id, m]): RuledOut => ({ issue, cause: nameOf(issue, id), why: testText(m), by: 'team', role: m.role })),
  ])
  const confirmed = focus.flatMap((issue): Confirmed[] => Object.entries(issue.causeMarks).filter(([, m]) => m.state === 'confirmed').map(([id, m]) => ({ issue, cause: nameOf(issue, id), text: m.text, role: m.role })))
  const causeLines = new Map(focus.map((issue): [string, CauseLine[]] => [issue.key, [
    ...Object.entries(issue.latest?.ruledOut ?? {}).map(([id, why]): CauseLine => ({ kind: 'ruled-out', by: 'logs', cause: nameOf(issue, id), text: why })),
    ...Object.entries(issue.causeMarks).filter(([, m]) => m.state === 'ruled-out').map(([id, m]): CauseLine => ({ kind: 'ruled-out', by: 'team', cause: nameOf(issue, id), text: testText(m), role: m.role })),
    ...Object.entries(issue.causeMarks).filter(([, m]) => m.state === 'confirmed').map(([id, m]): CauseLine => ({ kind: 'confirmed', by: 'team', cause: nameOf(issue, id), text: m.text, role: m.role })),
  ]]))
  const firstRead = board.handoff === null
  return { redsDue, deferralsDue, tried, ruledOut, confirmed, causeLines, newSince: board.rows.filter((i) => i.isNew), firstRead, pitLines: board.pitLines }
}
