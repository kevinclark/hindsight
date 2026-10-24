/**
 * Which event a run of on-field logs with no event name belongs to. The FMS leaves the event name blank in most of one
 * team's logs, so "Qualification 49" can be three different matches. The team's own qualification list on The Blue
 * Alliance says which event it was: the event whose list holds the cluster's match numbers.
 *
 * A cluster is what session grouping makes of those logs: on the field, no event name, each within 4 days of the last.
 * Playoff numbers are not used (FMS and TBA number them differently in some years). The robot clock can be wrong, so the
 * date only breaks a tie, and the distance between the clock and the event is recorded.
 */
import { eventInfo, teamEvents, teamMatches } from './api.ts'
import { TbaError, type TbaGet } from './source.ts'

export const EVENT_GAP = 4 * 86400e3

/** The least a log needs to say for the grouping and the matching: its place in time, whether it was on a field, and what the FMS called the event. */
export interface EventLog { fileName: string; playedAt: number | null; onField: boolean; event: string; matchLabel: string }

export interface ResolvedEvent {
  /** TBA's key ("2099test"), name (without the year, as TBA has it), dates (YYYY-MM-DD, event-local) and IANA time zone (null if TBA gave none). */
  key: string
  name: string
  start: string
  end: string
  timezone: string | null
  /** Days from the robot clock to the event: the nearest event day minus the cluster's first day. 0 when the clock puts it inside the event; 83 means the event was 83 days after the clock's date. */
  clockOffsetDays: number
  /** How many of the cluster's qualification numbers the team's list for this event holds, of how many the cluster has. */
  matched: number
  of: number
  /** 'quals' when the match numbers alone chose it; 'date' when several events held equally many and the date chose: a guess, shown as one. */
  by: 'quals' | 'date'
  /** The oldest of the copies the answer rests on (ms): what "as of" means when it came from the saved copy. */
  fetchedAt: number
  fromCache: boolean
}

export interface ClusterResult {
  /** The logs of the cluster, by file name. */
  files: string[]
  quals: number[]
  event: ResolvedEvent | null
  /** Why there is no event: 'no quals', 'no event', 'tie' (two held equally many and the date could not fairly choose), 'unreachable', 'refused' (The Blue Alliance did not accept the read key). */
  why: null | 'no quals' | 'no event' | 'tie' | 'unreachable' | 'refused'
  /** The keys that held the most, for a tie or a miss. */
  candidates: string[]
}

export interface Identification { byFile: Map<string, ResolvedEvent>; clusters: ClusterResult[] }

/** Qualification N -> N; any other label -> null. */
export const qualNumber = (label: string): number | null => { const m = /^Qualification (\d+)$/.exec(label.trim()); return m ? Number(m[1]) : null }

/** Blank-event on-field logs, grouped as session grouping groups them. `logs` need not be sorted. */
export function blankEventClusters<T extends Pick<EventLog, 'playedAt' | 'onField' | 'event'>>(logs: T[]): T[][] {
  const sorted = logs.filter((l) => l.onField && !l.event && l.playedAt !== null).sort((a, b) => a.playedAt! - b.playedAt!)
  const out: T[][] = []
  for (const l of sorted) {
    const open = out.find((c) => l.playedAt! - c.at(-1)!.playedAt! < EVENT_GAP)
    if (open) open.push(l); else out.push([l])
  }
  return out
}

const DAY = 86400e3
const dayNumber = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`) / DAY
/** The calendar date (YYYY-MM-DD) of a moment in a time zone; the laptop's own zone when none is given or it is not a zone. */
export function dayIn(ms: number, timeZone: string | null): string {
  if (timeZone) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms) } catch { /* fall through */ }
  }
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "2099 Test Regional": TBA names most events without the year. */
export const eventLabel = (name: string, key: string): string => (/\b(19|20)\d\d\b/.test(name) ? name : `${name} ${key.slice(0, 4)}`)
export const REFUSED_WORDS = 'The Blue Alliance did not accept the read key.'
export const clockOffsetText = (days: number): string => (days === 0 ? '' : `robot clock ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} off`)

/**
 * Find the event of every blank-event cluster in `logs`. Reads the team's events for the year of the cluster and the year
 * either side, and the team's match list of each. Never throws for a missing answer: a cluster that cannot be decided has
 * `event: null` and says why.
 */
export async function identifyEvents(logs: EventLog[], team: number, get: TbaGet): Promise<Identification> {
  const byFile = new Map<string, ResolvedEvent>()
  const clusters: ClusterResult[] = []
  for (const c of blankEventClusters(logs)) {
    const quals = [...new Set(c.map((l) => qualNumber(l.matchLabel)).filter((n): n is number => n !== null))].sort((a, b) => a - b)
    const files = c.map((l) => l.fileName)
    const result: ClusterResult = { files, quals, event: null, why: null, candidates: [] }
    clusters.push(result)
    if (quals.length === 0) { result.why = 'no quals'; continue }
    try {
      const first = c[0].playedAt!
      const year = new Date(first).getUTCFullYear()
      const events = new Map<string, Awaited<ReturnType<typeof teamEvents>>['data'][number]>()
      let oldest = Infinity, anyLive = false
      const note = (f: { fetchedAt: number; fromCache: boolean }) => { oldest = Math.min(oldest, f.fetchedAt); if (!f.fromCache) anyLive = true }
      for (const y of [year - 1, year, year + 1]) {
        const got = await teamEvents(get, team, y)
        note(got)
        for (const e of got.data) events.set(e.key, e)
      }
      const scored: { key: string; held: number; distance: number }[] = []
      for (const e of events.values()) {
        const got = await teamMatches(get, team, e.key, e.end_date)
        note(got)
        const list = new Set(got.data.filter((m) => m.comp_level === 'qm').map((m) => m.match_number))
        const held = quals.filter((q) => list.has(q)).length
        const mid = (dayNumber(e.start_date) + dayNumber(e.end_date)) / 2
        scored.push({ key: e.key, held, distance: Math.abs(mid - first / DAY) })
      }
      const best = Math.max(0, ...scored.map((s) => s.held))
      result.candidates = scored.filter((s) => s.held === best && best > 0).map((s) => s.key)
      if (best === 0 || best < 0.8 * quals.length) { result.why = 'no event'; continue }
      const top = scored.filter((s) => s.held === best).sort((a, b) => a.distance - b.distance)
      // The robot clock can be wrong by months, so it may break a tie only when the numbers say something: one shared number is no evidence.
      if (top.length > 1 && (quals.length < 2 || top[0].distance === top[1].distance)) { result.why = 'tie'; continue }
      const e = events.get(top[0].key)!
      const info = await eventInfo(get, e.key)
      note(info)
      const timezone = info.data.timezone ?? null
      const clockDay = dayNumber(dayIn(first, timezone))
      const [s, t] = [dayNumber(e.start_date), dayNumber(e.end_date)]
      const clockOffsetDays = clockDay < s ? s - clockDay : clockDay > t ? t - clockDay : 0
      result.event = {
        key: e.key, name: e.name, start: e.start_date, end: e.end_date, timezone, clockOffsetDays,
        matched: best, of: quals.length, by: top.length > 1 ? 'date' : 'quals', fetchedAt: oldest, fromCache: !anyLive,
      }
      for (const f of files) byFile.set(f, result.event)
    } catch (e) {
      result.why = e instanceof TbaError && (e.status === 401 || e.status === 403) ? 'refused' : 'unreachable'
    }
  }
  return { byFile, clusters }
}
