/** What the phone's Library list shows (src/ui/PhoneLibrary.svelte): labels, the event filter, days. Pure, tested. */
import type { Entry } from '../hub/catalog.ts'
import { FACETS, FACET_LABELS, type FacetId, type Selection } from '../hub/facets.ts'
import { dayText } from '../hub/layout.ts'
import { enabledSeconds, offFieldKind } from '../hub/log-kind.ts'
import { mb } from '../hub/transfer-watch.ts'
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

/** Megabytes as the Library writes them: one decimal under 10 MB, none above (the one formatter, src/hub/transfer-watch.ts). */
export { mb }

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

/** A clock time as this device writes it, "9:49 AM" (a 24-hour phone gets "09:49"). */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** A day's heading, "Sun Nov 8" in the device's language, without the comma after the weekday; the year follows when it is not this year's. */
export function dayHeading(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const year = d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const }
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...year }).replace(',', '')
}

/** When a row's logs were played: each distinct time once, so two copies of one match at one time read "9:49 AM", not twice. */
export const whenOf = (group: Entry[]): string => [...new Set(group.map((e) => rowParts(e).when).filter(Boolean))].join(', ')

/** One log's row text: `label` (bold for a match), when it was played, and `extra` ("34 s enabled" on an on-check). */
export interface RowParts { label: string; when: string; extra: string | null; bold: boolean; muted: boolean }

export function rowParts(e: Entry): RowParts {
  const r = e.record
  const when = r.playedAt === null ? '' : clock(r.playedAt)
  const kind = offFieldKind(r)
  if (kind === 'on-check') return { label: 'On-check', when, extra: `${Math.round(enabledSeconds(r))} s enabled`, bold: false, muted: true }
  if (kind === 'brief') return { label: 'Enabled under 1 s', when, extra: null, bold: false, muted: true }
  if (kind === 'not-enabled') return { label: 'Not enabled', when, extra: null, bold: false, muted: true }
  if (kind === 'unread') return { label: 'Off the field', when, extra: null, bold: false, muted: true }
  return { label: logLabel(r), when, extra: null, bold: true, muted: false }
}

/** A row: one log, or the logs of one match (a restart, or two laptops' copies). `muted`: an on-check or a lone quiet log. */
export interface RowItem { type: 'row'; entries: Entry[]; muted: boolean }
/** Quiet off-the-field logs between two rows, folded into one line that says how many of each and when. */
export interface FoldItem { type: 'fold'; entries: Entry[]; text: string }
export interface DayItems { day: string; heading: string; items: (RowItem | FoldItem)[] }

/** The quiet logs: off the field, never enabled or not read (an on-check, or a brief enable, is a row). */
const isQuiet = (e: Entry): boolean => { const k = offFieldKind(e.record); return k === 'not-enabled' || k === 'unread' }

function foldText(group: Entry[]): string {
  const count = (kind: string) => group.filter((e) => offFieldKind(e.record) === kind).length
  const parts = [[count('not-enabled'), 'not enabled'], [count('unread'), 'off the field']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`)
  const times = group.flatMap((e) => (e.record.playedAt === null ? [] : [e.record.playedAt]))
  if (times.length === 0) return parts.join(', ')
  const [a, b] = [clock(Math.min(...times)), clock(Math.max(...times))]
  const range = a === b ? a : `${a}–${b}` // both in full: the device's own format decides where an AM/PM goes
  return `${parts.join(', ')} · ${range}`
}

/**
 * The list as rows, by day (newest first as given): matches and on-checks are rows; quiet logs between two rows fold into
 * one line, a lone one is a muted row, and the newest group in the whole list stays open as rows (it may be the log you just
 * made). Two on-field logs of one match on one day (same event, type and number) are one row at the newer one's place.
 */
export function dayItems(entries: Entry[]): DayItems[] {
  const days = byDay(entries).map((d) => {
    const items: (RowItem | FoldItem | { type: 'quiet'; entries: Entry[] })[] = []
    const merged = new Map<string, RowItem>()
    for (const e of d.logs) {
      const r = e.record
      if (isQuiet(e)) {
        const last = items.at(-1)
        if (last?.type === 'quiet') last.entries.push(e); else items.push({ type: 'quiet', entries: [e] })
        continue
      }
      const key = r.onField && r.matchNumber !== null ? `${r.event}|${r.matchType}|${r.matchNumber}` : null
      const same = key === null ? undefined : merged.get(key)
      if (same) { same.entries.push(e); continue }
      const row: RowItem = { type: 'row', entries: [e], muted: rowParts(e).muted }
      if (key !== null) merged.set(key, row)
      items.push(row)
    }
    return { day: d.day, heading: d.logs[0].record.playedAt === null ? d.day : dayHeading(d.logs[0].record.playedAt), items }
  })
  const newest = days.flatMap((d) => d.items).filter((i) => i.type === 'quiet').reduce<{ entries: Entry[] } | null>((best, g) => {
    const at = (x: { entries: Entry[] }) => Math.max(...x.entries.map((e) => e.record.playedAt ?? -Infinity))
    return !best || at(g) > at(best) ? g : best
  }, null)
  return days.map((d) => ({
    ...d,
    items: d.items.flatMap((i): (RowItem | FoldItem)[] => {
      if (i.type !== 'quiet') return [i]
      const rows = () => i.entries.map((e): RowItem => ({ type: 'row', entries: [e], muted: true }))
      return i.entries.length === 1 || i === newest ? rows() : [{ type: 'fold', entries: i.entries, text: foldText(i.entries) }]
    }),
  }))
}

/** The facets' picks as one line over the list, "Qualification, On-check · 12 of 36 logs"; empty when nothing is picked. */
export function activeLine(selection: Selection, shown: number, total: number): string {
  const picks = FACETS.flatMap((f) => selection[f] ?? [])
  return picks.length ? `${picks.join(', ')} · ${shown} of ${total} log${total === 1 ? '' : 's'}` : ''
}
export { FACET_LABELS }

/**
 * How the Filters sheet lays out the facets: Log type first, then the facets with a real choice (two or more values, or a
 * pick to undo) as checkboxes; a facet with a single value in the shown logs is one line of text at the end, "Only one value:
 * School year 2026-2027 · Season Off-season", since nothing can be filtered by it. A facet with no log at all is left out.
 */
export function sheetFacets(counts: Record<FacetId, [value: string, count: number][]>, selection: Selection): { multi: FacetId[]; single: { label: string; value: string }[] } {
  const order = ['logType', ...FACETS.filter((f) => f !== 'logType')] as FacetId[]
  const multi = order.filter((f) => counts[f].length > 1 || (selection[f]?.length ?? 0) > 0)
  const single = order.filter((f) => !multi.includes(f) && counts[f].length === 1).map((f) => ({ label: FACET_LABELS[f], value: counts[f][0][0] }))
  return { multi, single }
}
