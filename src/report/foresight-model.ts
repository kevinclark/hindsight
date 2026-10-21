/** What the Foresight report and its phone card say, from the screen's own derived values (ForesightView.svelte). */

import type { CardModel, Tone } from './card.ts'
import { buildLine, cardTitle, keyNumber, type BuildLine } from './review-model.ts'
import type { VerdictItem } from '../foresight/verdict.ts'
import type { MarkedLine } from '../foresight/onchecks.ts'
import { VERSION } from '../version.ts'

export interface ForesightReportInput {
  verdict: 'GO' | 'NO-GO' | 'NOT CHECKED'
  why: string
  /** The connection as the screen says it ("connected", "closed", ...) and its message. */
  state: string
  message: string
  url: string | null
  /** When these readings were taken. */
  readAt: Date
  robot: string | null
  items: VerdictItem[]
  onchecks: MarkedLine[]
  battery: number | null
  controllers: string[]
  build: { sha: string; branch: string; dirty: string } | null
  notChecked: { rule: string; reason: string }[]
}

/** A 40-hex git sha in a line of text shortened to the 7 characters the card and the printed report show. */
export const shortShas = (text: string) => text.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7))

/** The verdict box's sub-line: how many of the checks did not run in full (the same count as the "Not checked or partly checked" line). */
export const didNotRun = (n: number, total: number) => (n > 0 ? `${n} of ${total} checks not fully run` : null)

const p2 = (n: number) => String(n).padStart(2, '0')
export const stamp = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
export const fileStamp = (d: Date) => stamp(d).replace(/[ :]/g, '-')

export const VERDICT_TONE: Record<ForesightReportInput['verdict'], Tone> = { GO: 'ok', 'NO-GO': 'error', 'NOT CHECKED': 'muted' }

export function foresightBuild(i: ForesightReportInput): BuildLine | null {
  return i.build ? buildLine(i.build) : null
}

export function foresightCard(i: ForesightReportInput): CardModel {
  const reds = i.items.filter((x) => x.level === 'red')
  const ambers = i.items.filter((x) => x.level === 'amber')
  const build = foresightBuild(i)
  // A number the title already says is not said again under it; that includes a 40-hex sha the title shows as its
  // first 7 characters. Only the sha case is matched by text: a bare substring would drop "1" under "13 s".
  const item = (x: VerdictItem, word: string, tone: Tone) => {
    const n = keyNumber(x.finding)
    const title = cardTitle(x.finding.title)
    const said = n.inTitle || (/^[0-9a-f]{40}$/i.test(n.value) && title.includes(n.value.slice(0, 7)))
    return { word, tone, title, number: said ? '' : shortShas(n.text) }
  }
  const items = [...reds.map((x) => item(x, 'FIX', 'error')), ...ambers.map((x) => item(x, 'LOOK AT', 'warning'))]
  return {
    context: 'Foresight pit check',
    heading: i.verdict,
    headingTone: VERDICT_TONE[i.verdict],
    subheading: i.why + (ambers.length ? ` · ${ambers.length} to look at` : ''),
    items,
    emptyText: i.verdict === 'GO' ? 'Nothing to fix.' : i.verdict === 'NOT CHECKED' ? 'Not judged: this is not a GO.' : '',
    footer: [`read ${stamp(i.readAt)}${i.robot ? ` · ${i.robot}` : ''}`, build ? build.text : `connection: ${i.state}`, `Hindsight ${VERSION}`],
    // The fact is said by the headline item and the footer; the box says it only when the first item (always drawn)
    // does not, since items after it can be cut to fit the card.
    uncommitted: !!build?.uncommitted && !/uncommitted/i.test(items[0]?.title ?? ''),
    uncommittedText: 'UNCOMMITTED CODE on the robot',
  }
}
