/**
 * The two sheets a shift reads: the queue sheet (what to confirm before the next match, printed for the pit crew to pass to
 * the drive team) and the handoff (what the next shift needs to know). Pure models of the board; the screens draw them.
 */
import { makerOf } from '../rules/index.ts'
import type { Board, BoardIssue } from './model.ts'
import { isChecked, isGate } from './model.ts'

/** A sheet holds at most this many lines (a tired reader at the field): over it says "n more on the board". */
export const SHEET_LINES = 7

export interface QueueLine {
  kind: 'gate' | 'deferral'
  issue: BoardIssue
  /** Gate lines: the role and time of the tick, once checked. */
  checked: { role: string; when: string } | null
}

export interface QueueSheet {
  /** The match this sheet is for ("Q41", or "after Q33" with no schedule): the key a tick is filed under. */
  forMatch: string
  /** The same, for people: "Q41", or "the next match" with no schedule. */
  forLabel: string
  /** NOT CLEARED: n RED(S) TO CONFIRM, or GO WITH n DEFERRAL(S) · m RED(S) OPEN. Never green, never plain GO. */
  verdict: { cleared: boolean; text: string }
  toConfirm: number
  deferrals: number
  redsOpen: number
  gate: number
  lines: QueueLine[]
  /** Items past the line cap. */
  more: number
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

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
  const toConfirm = gate.filter((i) => !isChecked(i, tickFor)).length
  const all: QueueLine[] = [
    ...gate.map((issue): QueueLine => {
      const c = issue.checked.filter((x) => x.match === tickFor).at(-1)
      return { kind: 'gate', issue, checked: c ? { role: c.role, when: c.when } : null }
    }),
    ...deferrals.map((issue): QueueLine => ({ kind: 'deferral', issue, checked: null })),
  ]
  const text = toConfirm
    ? `NOT CLEARED: ${toConfirm} ${plural(toConfirm, 'RED', 'REDS')} TO CONFIRM`
    : `GO WITH ${deferrals.length} ${plural(deferrals.length, 'DEFERRAL', 'DEFERRALS')} · ${redsOpen} ${plural(redsOpen, 'RED', 'REDS')} OPEN`
  return {
    forMatch: tickFor, forLabel: board.tickLabel, verdict: { cleared: toConfirm === 0, text }, toConfirm, deferrals: deferrals.length, redsOpen, gate: gate.length,
    lines: all.slice(0, SHEET_LINES), more: Math.max(0, all.length - SHEET_LINES),
  }
}

export interface RuledOut { issue: BoardIssue; cause: string; why: string }

export interface Handoff {
  /** Reds due before the next match, and deferrals due. */
  redsDue: BoardIssue[]
  deferralsDue: BoardIssue[]
  /** What was tried: every note on those issues, oldest first (by the order the board keeps them), with the match and role. */
  tried: { issue: BoardIssue; text: string; role: string; match: string | null; when: string }[]
  /** Causes the logs ruled out for those issues (the latest finding's own, from Hindsight's evidence). */
  ruledOut: RuledOut[]
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
  const tried = focus.flatMap((issue) => issue.notes.map((n) => ({ issue, text: n.text, role: n.role, match: n.match, when: n.when }))).sort((a, b) => a.when.localeCompare(b.when))
  const ruledOut = focus.flatMap((issue) => {
    const causes = makerOf(issue.rule)?.causes ?? []
    return Object.entries(issue.latest?.ruledOut ?? {}).map(([id, why]) => ({ issue, cause: causes.find((c) => c.id === id)?.cause ?? id, why }))
  })
  const firstRead = board.handoff === null
  return { redsDue, deferralsDue, tried, ruledOut, newSince: board.rows.filter((i) => i.isNew), firstRead, pitLines: board.pitLines }
}
