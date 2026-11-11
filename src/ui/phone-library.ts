/** What the phone's Library list shows (src/ui/PhoneLibrary.svelte): labels, the event filter, days. Pure, tested. */
import type { Entry } from '../hub/catalog.ts'
import { dayText } from '../hub/layout.ts'
import type { LogRecord } from '../hub/types.ts'
import type { MatchSummary } from '../session/summary.ts'

/** The filter value for logs with no event name. */
export const NO_EVENT = '\u0000none'

/** Above this a log opened on an iPhone 17 Pro (the team's p99 log size, 275 MB); older phones are not measured. */
export const LARGE_BYTES = 275 * 2 ** 20
export const isLarge = (bytes: number): boolean => bytes > LARGE_BYTES

export function logLabel(r: Pick<LogRecord, 'matchType' | 'matchNumber' | 'onField'>): string {
  if (r.matchNumber !== null && r.matchType === 2) return `Q${r.matchNumber}`
  if (r.matchNumber !== null && r.matchType === 3) return `Playoff ${r.matchNumber}`
  if (r.matchNumber !== null && r.matchType === 1) return `Practice ${r.matchNumber}`
  return r.onField ? 'On the field' : 'Off the field'
}

/** '' keeps every log; NO_EVENT those with no event name; otherwise that event's. */
export function filterByEvent(entries: Entry[], event: string): Entry[] {
  return entries.filter((e) => event === '' || (event === NO_EVENT ? !e.record.event : e.record.event === event))
}

/** Consecutive logs of one day together, in the order given (newest first from the hub; undated logs come last). */
export function byDay(entries: Entry[]): { day: string; logs: Entry[] }[] {
  const out: { day: string; logs: Entry[] }[] = []
  for (const e of entries) {
    const day = e.record.playedAt === null ? 'No date' : dayText(e.record.playedAt)
    const last = out.at(-1)
    if (last?.day === day) last.logs.push(e); else out.push({ day, logs: [e] })
  }
  return out
}

/** Only the logs kept on this phone (the log and its DS logs all kept): what opens with no download, and offline. */
export function onThisPhone(entries: Entry[], kept: ReadonlySet<string>): Entry[] {
  return entries.filter((e) => [e.record, ...e.attached.dslog, ...e.attached.dsevents].every((r) => kept.has(r.sha256)))
}

/** Megabytes as the Library writes them: one decimal under 10 MB, none above. */
export const mb = (n: number): string => (n >= 10 * 2 ** 20 ? (n / 2 ** 20).toFixed(0) : (n / 2 ** 20).toFixed(1))

/** What opening an entry downloads: the log and its Driver Station logs. */
export const sizeOf = (e: Entry): number => [e.record, ...e.attached.dslog, ...e.attached.dsevents].reduce((n, r) => n + r.size, 0)

/**
 * The Library entry a match summary was made from. The log's sha-256 when the event line carries it and a Library entry has
 * it; else the entry one of whose names is the summary's file name and whose log has the summary's size. Null when none
 * matches, or when more than one does (never guess which). A match recorded in several logs (the robot program restarted
 * mid-match) gets the summary only: no one log is the match.
 */
export function entryForSummary(entries: Entry[], summary: Pick<MatchSummary, 'fileName' | 'fileSize'> & { sha256?: string | null; pieces?: string[] }): Entry | null {
  if ((summary.pieces?.length ?? 0) > 1) return null
  if (summary.sha256) {
    const bySha = entries.filter((e) => e.record.sha256 === summary.sha256)
    if (bySha.length === 1) return bySha[0]
  }
  const found = entries.filter((e) => e.names.includes(summary.fileName) && e.record.size === summary.fileSize)
  return found.length === 1 ? found[0] : null
}

/**
 * What Match review does for a summary on the phone: `entry` is its log in the Library, `kept` says the phone holds it, and
 * `auto` says it may open by itself (kept, and not above LARGE_BYTES: an open that big is a button press, never a surprise).
 * Null when the Library has no such log: the summary stays.
 */
export function reviewTarget(entries: Entry[] | null, kept: ReadonlySet<string>, summary: Parameters<typeof entryForSummary>[1] | null): { entry: Entry; kept: boolean; auto: boolean; large: boolean } | null {
  const entry = entries && summary ? entryForSummary(entries, summary) : null
  if (!entry) return null
  const isKept = onThisPhone([entry], kept).length > 0
  const large = isLarge(sizeOf(entry))
  return { entry, kept: isKept, auto: isKept && !large, large }
}

/** The rules the laptop's summary has more findings for than a read made on this phone, by rule id, in the summary's order. */
export function moreInSummary(summary: Pick<MatchSummary, 'rules'>, findings: readonly { rule: string }[]): { rule: string; more: number }[] {
  const here = new Map<string, number>()
  for (const f of findings) here.set(f.rule, (here.get(f.rule) ?? 0) + 1)
  return Object.entries(summary.rules).flatMap(([rule, r]) => {
    const more = r.findings.length - (here.get(rule) ?? 0)
    return more > 0 ? [{ rule, more }] : []
  })
}

/**
 * The line over a full review the phone read itself: "Read on this phone." and, when the laptop's summary has more findings
 * for some rule, which. A robot code folder is named only as a fact about the laptop (the phone never has one).
 */
export function readHereLine(summary: Pick<MatchSummary, 'rules' | 'codeFolder'>, findings: readonly { rule: string }[]): string {
  const gaps = moreInSummary(summary, findings)
  if (gaps.length === 0) return 'Read on this phone.'
  const total = gaps.reduce((n, g) => n + g.more, 0)
  const code = summary.codeFolder ? ' It had the robot code folder; this phone has none.' : ''
  return `Read on this phone. The laptop's read found ${total} more (${gaps.map((g) => g.rule).join(', ')}).${code}`
}
