/** The board's wording, in one place so the rows, the detail, the sheets and the tests say the same thing. */
import type { BoardIssue } from './model.ts'
import { PRIORITY_WORDS, STATUS_WORDS } from './model.ts'

/** "Workaround until Q51 · re-decide at Q51" for a live deferral (never "Deferred until … · Due …": students read that as "fix by"); else the status word. */
export function statusLine(i: BoardIssue): string {
  if (i.status === 'deferred' && i.deferral) return `Workaround until ${i.deferral.point.until} · re-decide ${i.deferral.point.redecide}`
  return STATUS_WORDS[i.status]
}

/** "Due before Q41" for an issue that is not deferred; empty for a deferred one (its status line already says when). */
export const dueLine = (i: BoardIssue): string => (i.status === 'deferred' || i.grey ? '' : i.awaitingClean ? 'Closes after a clean match where the rule can be checked' : i.due.over ? 'Open · the event is over' : `Due ${i.due.text}`)

export const changedLine = (i: BoardIssue): string => (i.lastChange ? `Last changed${i.lastChange.match ? ` ${i.lastChange.match}` : ''} by ${i.lastChange.role}` : 'Not changed yet')

export const ownerText = (i: BoardIssue): string => i.owner ?? 'no owner yet'

/** "Drivetrain · Motors on one loop at different speeds (Front left)". */
export const rowTitle = (i: BoardIssue): string => `${i.mechanism} · ${i.ruleTitle}${i.about && i.about !== i.mechanism ? ` (${i.about})` : ''}`

export const priorityWord = (i: BoardIssue): string => (i.grey ? 'Grey' : PRIORITY_WORDS[i.priority])
export const priorityIcon = (i: BoardIssue): string => (i.grey ? '○' : i.priority === 'red' ? '●' : i.priority === 'amber' ? '▲' : '○')

/** Short tags beside a row. */
export function tags(i: BoardIssue): string[] {
  return [
    ...(i.cameBack ? ['Came back after a fix'] : []),
    ...(i.deferral?.expired ? ['Deferral ended'] : []),
    ...(i.isNew ? ['New'] : []),
    ...(i.lastChange?.role === 'mentor' ? ['Last change by mentor'] : []),
  ]
}

export const clockText = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }

/** "1 RED", "2 REDS": the verdict words' counts. */
export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/**
 * The words for a go that still has work open, in one place so the queue sheet and Foresight never word it differently:
 * "GO WITH 2 DEFERRALS". Never green and never plain GO (WCAG 1.4.1: the word carries the count, not the colour).
 */
export const goWithWord = (deferrals: number): string => `GO WITH ${deferrals} ${plural(deferrals, 'DEFERRAL', 'DEFERRALS')}`

/** The queue sheet's verdict: NOT CLEARED: n RED(S) TO CONFIRM, or the go-with word and the reds still open. */
export function queueVerdictText(toConfirm: number, deferrals: number, redsOpen: number): string {
  return toConfirm
    ? `NOT CLEARED: ${toConfirm} ${plural(toConfirm, 'RED', 'REDS')} TO CONFIRM`
    : `${goWithWord(deferrals)} · ${redsOpen} ${plural(redsOpen, 'RED', 'REDS')} OPEN`
}
