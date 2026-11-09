import type { Finding } from '../rules/types.ts'
import { makerOf } from '../rules/index.ts'

/** Finding titles shortened for tight places: the phone card, the bottom line, a note under a finding. */

/** The card's title without its asides, then cut at a stop (", first at ", " (first at ", "(median …") and at 70 characters on a word boundary. */
export function shortTitle(title: string): string {
  const cut = cardTitle(title).split(/, first at | \(first at |\s*\((?:median|worst) /)[0].trim()
  if (cut.length <= 70) return cut
  const words = cut.slice(0, 69).split(' ')
  if (words.length > 1 && cut[69] !== ' ') words.pop()
  return `${words.join(' ').replace(/[\s,;:]+$/, '')}…`
}

/** A finding's title for the card: without the "(teleop; robot time 417.4 s)" aside, which the PDF keeps (card space is tight). */
export function cardTitle(title: string): string {
  return title.replace(/\s*\([^()]*robot time [\d.]+ s\)/g, '').replace(/\s*\(as of [^()]*\)/g, '').replace(/\s+/g, ' ').trim()
}

/** The closed row's time, compact: "2:38 into the match (teleop; robot time 507.1 s)" -> "2:38 teleop"; "0:12 into run 3 of 7 (teleop; …)" -> "run 3 · 0:12 teleop". */
function compactWhen(when: string | null): string {
  if (!when) return ''
  const paren = /\(([^;)]*)/.exec(when)
  const head = when.replace(/\s*\(.*$/, '').trim()
  if (!paren) return when.split(/[,;]/)[0].trim()
  const mode = paren[1].trim()
  const t = /^(\d+:\d{2})\s+into\s+(?:the match|run (\d+) of \d+)/.exec(head)
  if (!t) return [head, mode].filter(Boolean).join(' ')
  return [t[2] ? `run ${t[2]} ·` : '', t[1], mode].filter(Boolean).join(' ')
}

/** What a finding's closed row shows: the rule's short title, what it is about, the judged number (measured only), and when. The long sentence is `finding.title`, kept inside the opened row. */
export function rowHeadline(f: Finding): { lead: string; about: string; key: string; time: string } {
  const lead = makerOf(f.rule)?.title ?? cardTitle(f.title)
  const about = f.about && !lead.toLowerCase().includes(f.about.toLowerCase()) ? f.about : ''
  const m = f.measured?.[0]
  const unit = m?.unit ? ` ${m.unit}` : ''
  const key = m ? `${m.value}${unit}${m.label ? ` ${m.label}` : ''}${m.threshold !== undefined ? ` (line ${m.threshold}${unit})` : ''}` : ''
  return { lead, about, key, time: compactWhen(f.when) }
}
