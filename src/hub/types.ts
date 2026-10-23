/**
 * What a library knows about a log, and how it is written down. A manifest is a text file of one JSON object per line;
 * each machine writes only its own (`manifests/<machine id>.jsonl`), so Drive never makes a conflict copy. The library
 * is the union of every manifest. Nothing here names a path on a machine, a person or a team.
 */

export type LogKind = 'wpilog' | 'hoot' | 'dslog' | 'dsevents'

export const LOG_EXTENSIONS: Record<string, LogKind> = { '.wpilog': 'wpilog', '.hoot': 'hoot', '.dslog': 'dslog', '.dsevents': 'dsevents' }

/** The kind a file name says, or null for anything that is not a log. */
export function kindOf(name: string): LogKind | null {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : LOG_EXTENSIONS[name.slice(dot).toLowerCase()] ?? null
}

export type DateSource = 'robot clock' | 'file name' | 'driver station clock' | 'file time' | 'unknown'

/** The repository whose code a log ran, found by the Library view's "Link code" (src/hub/codelink.ts). */
export interface CodeLink {
  /** "owner/name" on GitHub. */
  repo: string
  /** 'sha': the log's build commit is in that repo. 'codebase': only the log's Codebase text is recorded by that repo's code. */
  linkedBy: 'sha' | 'codebase'
  /** The full 40-character commit, when linkedBy is 'sha'. */
  sha?: string
  /** Other repos that record the same Codebase text and lost the tie-break. */
  candidates?: string[]
  checkedAt: number
}

/** "owner/name" or an organization / user name: what a GitHub source may be (no `node:` here; the page validates too). */
export const GITHUB_SOURCE = /^[\w.-]+(\/[\w.-]+)?$/
export const validSource = (text: string): boolean => GITHUB_SOURCE.test(text) && !text.includes('..')

/** The fields of a log record that a later reading (a `meta` record) may set. Nothing else in a meta is ever laid over a log. */
export const DESCRIBABLE_KEYS = ['wall', 'matchWindow', 'event', 'matchType', 'matchNumber', 'onField', 'batteryId', 'roboRio', 'edition', 'robot', 'build', 'stub', 'hardwareId', 'code'] as const
/** The fields that decide where a file lives (and so its identity in the library): set by the first reading, never by a later one. */
export const FIXED_KEYS = ['kind', 'playedAt', 'dateSource'] as const
export type DescribableKey = (typeof DESCRIBABLE_KEYS)[number]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const orNull = (ok: (v: unknown) => boolean) => (v: unknown) => v === null || ok(v)
const span = orNull((v) => isObject(v) && finite(v.start) && finite(v.end))

export function isCodeLink(v: unknown): v is CodeLink {
  return isObject(v) && typeof v.repo === 'string' && validSource(v.repo) && v.repo.includes('/') && (v.linkedBy === 'sha' || v.linkedBy === 'codebase')
    && (v.sha === undefined || (typeof v.sha === 'string' && /^[0-9a-f]{40}$/.test(v.sha)))
    && (v.candidates === undefined || (Array.isArray(v.candidates) && v.candidates.every((c) => typeof c === 'string')))
    && finite(v.checkedAt)
}

const SHAPES: Record<DescribableKey, (v: unknown) => boolean> = {
  wall: span, matchWindow: span,
  event: (v) => typeof v === 'string',
  matchType: orNull(finite), matchNumber: orNull(finite),
  onField: (v) => typeof v === 'boolean', stub: (v) => typeof v === 'boolean',
  batteryId: orNull((v) => typeof v === 'string'), roboRio: orNull((v) => typeof v === 'string'), edition: orNull((v) => typeof v === 'string'), hardwareId: orNull((v) => typeof v === 'string'),
  robot: orNull((v) => isObject(v) && typeof v.name === 'string' && (v.profileId === null || typeof v.profileId === 'string') && (v.how === undefined || typeof v.how === 'string') && (v.fit === undefined || v.fit === null || finite(v.fit))),
  build: orNull((v) => isObject(v) && typeof v.sha === 'string' && typeof v.branch === 'string'),
  code: (v) => isCodeLink(v),
}

/**
 * The fields of a reading that a log record may take: only the describable keys, each of the shape the page and the rules
 * rely on. A manifest from a teammate is untrusted input, so a field of the wrong shape (or any other key) is dropped.
 */
export function usableReading(meta: unknown): Partial<LogMeta> {
  if (!isObject(meta)) return {}
  return Object.fromEntries(DESCRIBABLE_KEYS.filter((k) => k in meta && meta[k] !== undefined && SHAPES[k](meta[k])).map((k) => [k, meta[k]])) as Partial<LogMeta>
}

export interface LogRobot {
  profileId: string | null
  name: string
  how: 'chosen by you' | 'codebase and branch' | 'codebase' | 'signals' | 'given'
  fit: number | null
}

/** What reading a log (src/hub/describe.ts) says about it. */
export interface LogMeta {
  kind: LogKind
  /** When it was recorded (ms since 1970) and where that came from; null when neither the robot clock nor the name says. */
  playedAt: number | null
  dateSource: DateSource
  /** The span the file covers on the wall clock (ms), when it can be known. DS logs and robot logs are lined up by it. */
  wall: { start: number; end: number } | null
  /** The match itself (enabled auto to the end of the last enabled period), wall clock ms; robot logs only. */
  matchWindow: { start: number; end: number } | null
  /** Robot logs only from here. FMS event name ('' when the DS logged none). */
  event: string
  /** /DriverStation/MatchType as logged: 0 none, 1 practice, 2 qualification, 3 elimination; null when the log has none. */
  matchType: number | null
  matchNumber: number | null
  onField: boolean
  batteryId: string | null
  /** The roboRIO's serial number, as AdvantageKit logs it (/SystemStats/SerialNumber): which controller ran, null when the log has none. */
  roboRio: string | null
  /** The robot's own name for which physical robot it is (its profile's `editionKey`), when the code builds more than one robot; null otherwise. */
  edition: string | null
  /**
   * The robot the log is from. A profile names it only when the log's own Codebase (and branch) matched one, or the profile
   * fit by signals; otherwise `profileId` is null and `name` is the Codebase text the log carries. Null when the log says nothing.
   * `how` is how the profile was chosen (src/profiles/choose.ts); `fit` is the share of the best profile's signals in the log.
   */
  robot: LogRobot | null
  build: { sha: string; branch: string } | null
  /** Set by linking code, never by reading the log. */
  code?: CodeLink
  /** Under 1 MB with no enabled time: a log the robot started and abandoned (akit_<hex>.wpilog on Drive today). */
  stub: boolean
  /** Hoot files: the part of the name before the timestamp ("rio", or a CANivore serial). */
  hardwareId: string | null
}

/** One log in the library, written when a machine brings it in. */
export interface LogRecord extends LogMeta {
  type: 'log'
  sha256: string
  md5?: string
  size: number
  /** Where the library keeps it: logs/<school year>/<date>/<name>, or logs/undated/<name>. */
  path: string
  /** Every name this content has been seen under, the first being the one it is filed under. */
  names: string[]
  /** The file's modified time when it was brought in (a roboRIO's for a pull); null if unknown. */
  modifiedTime: number | null
  /** Where it was brought in from: a folder on a machine, a Drive folder, or the robot. */
  from: 'folder' | 'drive' | 'robot'
  /** For a log brought in from Drive: its id there, so sync can copy it inside Drive instead of uploading it again. */
  sourceId?: string
  recordedAt: number
  machine: string
}

/** The same content seen under another name (the sha-256 is the identity). */
export interface AliasRecord { type: 'alias'; sha256: string; name: string; recordedAt: number; machine: string }

export type TagField = 'driver' | 'place' | 'battery' | 'robot'
export type TagTarget = { log: string } | { day: string }

/** A value typed in the Library view. The latest for a field and target wins; an empty value clears it. */
export interface TagRecord { type: 'tag'; target: TagTarget; field: TagField; value: string; recordedAt: number; machine: string }

/**
 * A later reading of a log already in the library (the describer improved). The catalog overlays the latest one on the log
 * record, except the fields that decide the file's path or identity (`kind`, `playedAt`, `dateSource`), which never change.
 */
export interface MetaRecord {
  type: 'meta'
  sha256: string
  meta: Partial<LogMeta>
  /** Which build of the describer wrote it: "<app version>+<source hash>" (a record from linking code carries the one it copied; '' when it copied none). */
  describer: string
  recordedAt: number
  machine: string
}

export type ManifestRecord = LogRecord | AliasRecord | TagRecord | MetaRecord

function validTarget(t: unknown): boolean {
  if (typeof t !== 'object' || t === null) return false
  const x = t as { log?: unknown; day?: unknown }
  return typeof x.log === 'string' || typeof x.day === 'string'
}

export function parseManifest(text: string): { records: ManifestRecord[]; skipped: number } {
  const records: ManifestRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const r = JSON.parse(line) as ManifestRecord
      if ((r.type === 'log' && typeof r.sha256 === 'string' && typeof r.path === 'string') || (r.type === 'alias' && typeof r.sha256 === 'string') || (r.type === 'meta' && typeof r.sha256 === 'string' && typeof r.meta === 'object' && r.meta !== null && !Array.isArray(r.meta)) || (r.type === 'tag' && typeof r.field === 'string' && typeof r.value === 'string' && validTarget(r.target))) records.push(r)
      else skipped++
    } catch { skipped++ }
  }
  return { records, skipped }
}

export function serializeRecord(r: ManifestRecord): string {
  return `${JSON.stringify(r)}\n`
}
