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

export type DateSource = 'robot clock' | 'file name' | 'driver station clock' | 'unknown'

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
  /** The robot profile that fit best, and how many of its signals the log has. */
  robot: { profileId: string; name: string } | null
  build: { sha: string; branch: string } | null
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
  recordedAt: number
  machine: string
}

/** The same content seen under another name (the sha-256 is the identity). */
export interface AliasRecord { type: 'alias'; sha256: string; name: string; recordedAt: number; machine: string }

export type TagField = 'driver' | 'place' | 'battery' | 'robot'
export type TagTarget = { log: string } | { day: string }

/** A value typed in the Library view. The latest for a field and target wins; an empty value clears it. */
export interface TagRecord { type: 'tag'; target: TagTarget; field: TagField; value: string; recordedAt: number; machine: string }

export type ManifestRecord = LogRecord | AliasRecord | TagRecord

export function parseManifest(text: string): { records: ManifestRecord[]; skipped: number } {
  const records: ManifestRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const r = JSON.parse(line) as ManifestRecord
      if ((r.type === 'log' && typeof r.sha256 === 'string' && typeof r.path === 'string') || (r.type === 'alias' && typeof r.sha256 === 'string') || (r.type === 'tag' && typeof r.field === 'string')) records.push(r)
      else skipped++
    } catch { skipped++ }
  }
  return { records, skipped }
}

export function serializeRecord(r: ManifestRecord): string {
  return `${JSON.stringify(r)}\n`
}
