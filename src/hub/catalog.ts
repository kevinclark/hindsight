/**
 * The library as the manifests describe it: every log once (by sha-256), the names it has been seen under, the tags
 * typed for it, and which DS logs and hoot files belong to which robot log. Pure: the app builds one from the manifest
 * files it holds and from a listing of `logs/`.
 */
import { dayText } from './layout.ts'
import { parseManifest, type LogRecord, type ManifestRecord, type TagField, type TagRecord } from './types.ts'

export type Tags = Partial<Record<TagField, string>>

export interface Entry {
  /** The log (the earliest record of its sha-256). */
  record: LogRecord
  /** Every name it has been seen under. */
  names: string[]
  /** Typed values that apply to it: a value for this log wins over one for its day. */
  tags: Tags
  /** The DS logs and hoot files that belong to it (robot logs only), by wall clock. */
  attached: { dslog: LogRecord[]; dsevents: LogRecord[]; hoot: LogRecord[] }
  /** Whether this machine holds the file. Set by the app, which can look. */
  local: boolean
  /** Whether the team store holds it. Set by the app after a listing. */
  shared: boolean
}

export class Catalog {
  private logs = new Map<string, LogRecord>()
  private extraNames = new Map<string, Set<string>>()
  private tagRecords: TagRecord[] = []
  private md5s = new Map<string, string>()
  skipped = 0

  static from(manifests: string[]): Catalog {
    const c = new Catalog()
    for (const text of manifests) {
      const { records, skipped } = parseManifest(text)
      c.skipped += skipped
      for (const r of records) c.add(r)
    }
    return c
  }

  add(r: ManifestRecord): void {
    if (r.type === 'log') {
      const have = this.logs.get(r.sha256)
      // Two machines that brought in the same bytes: the earlier record stands, the other's names are kept.
      if (!have || r.recordedAt < have.recordedAt) this.logs.set(r.sha256, { ...r, names: [...new Set([...r.names, ...(have?.names ?? [])])] })
      else have.names = [...new Set([...have.names, ...r.names])]
      if (r.md5) this.md5s.set(r.md5, r.sha256)
    } else if (r.type === 'alias') {
      const set = this.extraNames.get(r.sha256) ?? new Set()
      set.add(r.name)
      this.extraNames.set(r.sha256, set)
    } else this.tagRecords.push(r)
  }

  bySha(sha256: string): LogRecord | undefined { return this.logs.get(sha256) }
  byMd5(md5: string): LogRecord | undefined { const sha = this.md5s.get(md5); return sha ? this.logs.get(sha) : undefined }
  namesOf(sha256: string): string[] {
    const r = this.logs.get(sha256)
    return r ? [...new Set([...r.names, ...(this.extraNames.get(sha256) ?? [])])] : []
  }
  get size(): number { return this.logs.size }
  all(): LogRecord[] { return [...this.logs.values()] }

  /** The value for a field on a log: a tag on the log itself, else one on its day. Latest record wins; an empty value clears it (a cleared log tag shows the day's again). */
  tagsFor(r: LogRecord): Tags {
    const day = r.playedAt === null ? null : dayText(r.playedAt)
    const latest = (match: (t: TagRecord) => boolean, field: TagField) => this.tagRecords.filter((t) => t.field === field && match(t)).sort((a, b) => a.recordedAt - b.recordedAt).at(-1)
    const out: Tags = {}
    for (const field of ['driver', 'place', 'battery', 'robot'] as const) {
      const own = latest((t) => 'log' in t.target && t.target.log === r.sha256, field)
      const onDay = day === null ? undefined : latest((t) => 'day' in t.target && t.target.day === day, field)
      const chosen = own && own.value !== '' ? own : onDay
      if (chosen && chosen.value !== '') out[field] = chosen.value
    }
    return out
  }

  /**
   * The robot logs, each with its tags and the DS logs and hoot files that belong to it. A DS log or hoot file goes to the
   * robot log whose match (else whole log) it overlaps most on the wall clock; a hoot file is placed by the time in its name.
   */
  entries(): Entry[] {
    const all = this.all()
    const robots = all.filter((r) => r.kind === 'wpilog')
    const out = new Map<string, Entry>(robots.map((r) => [r.sha256, { record: r, names: this.namesOf(r.sha256), tags: this.tagsFor(r), attached: { dslog: [], dsevents: [], hoot: [] }, local: false, shared: false }]))
    for (const r of all) {
      if (r.kind === 'wpilog' || !r.wall && r.playedAt === null) continue
      const span = r.wall ?? { start: r.playedAt!, end: r.playedAt! }
      const best = robots.map((robot) => ({ robot, seconds: overlapMs(span, robot, r.kind === 'hoot') })).filter((x) => x.seconds > 0).sort((a, b) => b.seconds - a.seconds)[0]
      if (best) out.get(best.robot.sha256)!.attached[r.kind].push(r)
    }
    return [...out.values()].sort((a, b) => (a.record.playedAt ?? Infinity) - (b.record.playedAt ?? Infinity) || a.record.path.localeCompare(b.record.path))
  }
}

const SLACK_MS = 5 * 60e3

/** How much of the robot log's match (else its whole span) the span covers; a hoot file's single instant (its start) counts when it falls inside the robot log's span, with a few minutes' slack. */
function overlapMs(span: { start: number; end: number }, robot: LogRecord, instant: boolean): number {
  // A hoot file starts when the robot code did, long before the match: compare it with the whole log.
  const against = instant ? robot.wall ?? robot.matchWindow : robot.matchWindow ?? robot.wall
  if (!against) return 0
  if (instant) return span.start >= against.start - SLACK_MS && span.start <= against.end + SLACK_MS ? 1 : 0
  return Math.max(0, Math.min(span.end, against.end) - Math.max(span.start, against.start))
}
