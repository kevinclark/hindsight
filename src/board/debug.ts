/**
 * The debug workspace (ADR 3: debug is not a mode, it is a workspace opened from a finding or a symptom). Pure: for one
 * finding it lists the rule's possible causes in Hindsight's order, each with what to look at and the state the student
 * recorded (possible by default, ruled out by a test, confirmed), and says what the order rests on.
 *
 * The order is Hindsight's, and no backtest supports it, so the screen says "possible", never "likely". A switch (a
 * local setting, off by default) shows the same causes in reverse order: it is for a student test of whether the answer
 * follows the rank, and the screen names it while it is on.
 */
import type { Cause } from '../rules/rule.ts'
import type { BoardRole, CauseMark, CauseState } from '../triage/history.ts'

export const REVERSE_KEY = 'hindsight.debug.reverse'
type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Whether causes are shown in reverse order on this laptop (off unless it was switched on). */
export function readReverse(store: Store): boolean {
  try { return store.getItem(REVERSE_KEY) === 'on' } catch { return false }
}
export function writeReverse(store: Store, on: boolean): void {
  try { store.setItem(REVERSE_KEY, on ? 'on' : 'off') } catch { /* a private window: kept for this visit only */ }
}

/** The tag beside a cause that is not simply possible: one style and one case everywhere (workspace, issue detail, handoff). */
export const CAUSE_TAGS: Record<'ruled-out' | 'confirmed', string> = { 'ruled-out': 'ruled out', confirmed: 'confirmed' }
export const CAUSE_WORDS: Record<CauseState, string> = { possible: 'Possible', 'ruled-out': 'Ruled out', confirmed: 'Confirmed' }

export interface DebugCause {
  id: string
  cause: string
  look: string
  /** This log points to it (the finding's own `likely`). */
  points: boolean
  /** The rule's own reason for ruling it out on this log: Hindsight's, shown as such. */
  hindsightRuledOut: string | null
  state: CauseState
  /** For ruled-out: the test that was run. */
  test: string
  /** For ruled-out: what the test showed; otherwise the student's note. */
  text: string
  /** Who recorded the state, as a role only. */
  role: BoardRole | null
  when: string | null
}

export type CauseMarks = Record<string, { state: CauseState; test?: string; text: string; role?: BoardRole; by?: { role: BoardRole }; when: string }> | undefined

/** What the finding offers the ranking: the cause ids this log points to and the ones it rules out. */
export interface Ranking { likely?: string[]; ruledOut?: Record<string, string> }

/**
 * The causes of a finding in Hindsight's order: the ones this log points to first, then the rule's own order. `reverse`
 * flips the whole list (the student-test switch). A student's state is read from `marks` (the folded board state).
 */
export function debugCauses(causes: readonly Cause[], ranking: Ranking, marks: CauseMarks, reverse = false): DebugCause[] {
  const likely = new Set(ranking.likely ?? [])
  const ordered = [...causes].sort((a, b) => Number(likely.has(b.id)) - Number(likely.has(a.id)))
  const list = ordered.map((c): DebugCause => {
    const m = marks?.[c.id]
    return {
      id: c.id, cause: c.cause, look: c.look, points: likely.has(c.id), hindsightRuledOut: ranking.ruledOut?.[c.id] ?? null,
      state: m?.state ?? 'possible', test: m?.test ?? '', text: m?.text ?? '', role: m ? (m.role ?? m.by?.role ?? null) : null, when: m?.when ?? null,
    }
  })
  return reverse ? list.reverse() : list
}

/**
 * What the order rests on, in one sentence, in three forms: this log points at some causes (they are listed first), or it
 * singles out none (the rule's usual order). It never says "likely" and never ties the order to the evidence count.
 */
export function rankNote(pointed: number): string {
  const order = pointed > 0 ? `${pointed} listed first: this log points to ${pointed === 1 ? 'it' : 'them'}; the rest are in Hindsight's usual order for this rule` : "Hindsight's usual order for this rule; this log singles out none"
  return `${order}. They are possible causes, not likely ones: no backtest supports a ranking yet.`
}

/** "ruled out by <test>: <what it showed>". */
export const ruledOutText = (test: string, showed: string): string => [test.trim(), showed.trim()].filter(Boolean).join(': ')

/** What the student recorded, in words. */
export function markText(c: Pick<DebugCause, 'state' | 'test' | 'text'>): string {
  if (c.state === 'ruled-out') return `ruled out by ${ruledOutText(c.test, c.text) || 'a test (none written)'}`
  if (c.state === 'confirmed') return `confirmed${c.text ? `: ${c.text}` : ''}`
  return `possible${c.text ? `: ${c.text}` : ''}`
}
