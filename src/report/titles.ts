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
export function compactWhen(when: string | null): string {
  if (!when) return ''
  const paren = /\(([^;)]*)/.exec(when)
  const head = when.replace(/\s*\(.*$/, '').trim()
  if (!paren) return when.split(/[,;]/)[0].trim()
  const mode = paren[1].trim()
  const t = /^(\d+:\d{2})\s+into\s+(?:the match|run (\d+) of \d+)/.exec(head)
  if (!t) return [head, mode].filter(Boolean).join(' ')
  return [t[2] ? `run ${t[2]} ·` : '', t[1], mode].filter(Boolean).join(' ')
}

/**
 * The judged number for the closed row (measured only; the rule's `short` phrase when it has one, else its label only when it has no
 * line, since the line already says what it is). Two evidence shapes say more than the number, and the closed row keeps what they say:
 * - a configured current limit: the limit itself, not the check's line (120 % of it), and whether code switches it off;
 * - a camera that dropped out: the dropouts, which are why it fired, with the stale share only when that is past its line.
 */
function rowKey(f: Finding): string {
  const m = f.measured?.[0]
  if (!m) return ''
  const unit = m.unit ? ` ${m.unit}` : ''
  const e = f.evidence
  if (typeof e['configured limit (A)'] === 'number') {
    const off = /^no\b/.test(String(e['limit switched on in code'] ?? ''))
    return `${m.value}${unit} against a ${e['configured limit (A)']} A limit${off ? ', off in code' : ''}`
  }
  const drops = e['dropouts during the match']
  if (typeof drops === 'number' && drops > 0) {
    const secs = e['seconds disconnected']
    const past = m.threshold !== undefined && m.value > m.threshold ? ` · ${m.value}${unit} stale (line ${m.threshold}${unit})` : ''
    return `dropped out ${drops} ${drops === 1 ? 'time' : 'times'}${typeof secs === 'number' ? `, ${secs} s disconnected` : ''}${past}`
  }
  // A rule's short phrase says what a percentage is of ("156 % of a fast trip"), which a line alone doesn't.
  if (m.short) return `${m.value}${unit} ${m.short}${m.threshold !== undefined ? ` (line ${m.threshold}${unit})` : ''}`
  const label = m.value === 1 && m.one ? m.one : m.label
  return m.threshold !== undefined ? `${m.value}${unit} (line ${m.threshold}${unit})` : `${m.value}${unit}${label ? ` ${label}` : ''}`
}

/** What a finding's closed row shows: the rule's short title, what it is about, the judged number (`rowKey`), and when. The long sentence is `finding.title`, kept inside the opened row. */
export function rowHeadline(f: Finding): { lead: string; about: string; key: string; time: string } {
  const lead = makerOf(f.rule)?.title ?? cardTitle(f.title)
  const about = f.about && !lead.toLowerCase().includes(f.about.toLowerCase()) ? f.about : ''
  // An alert seen only outside the match has no time; say so where the time would be. Its in-window count is "times during the
  // match" on the field and "times across the N runs" off it (src/rules/alerts/passthrough.ts, view.ts).
  const inWindow = Object.keys(f.evidence).find((k) => k.startsWith('times ') && k !== 'times before or after the match')
  const outside = !f.when && inWindow !== undefined && f.evidence[inWindow] === 0 && Number(f.evidence['times before or after the match']) > 0
  return { lead, about, key: rowKey(f), time: outside ? 'before/after the match' : compactWhen(f.when) }
}
