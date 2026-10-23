/** Where a log is filed and what day it belongs to. The date is the machine's local date, as the Session view's practice days are. */
import type { LogMeta } from './types.ts'

/** Local calendar date, YYYY-MM-DD. */
export function dayText(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The school year (August to July) a moment falls in: "2026-2027" for 2026-10-17. */
export function schoolYear(ms: number): string {
  const d = new Date(ms)
  const start = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${start + 1}`
}

export const UNDATED = 'undated'

/** logs/<school year>/<date>/<name>, or logs/undated/<name> when no date is usable. */
export function libraryPath(meta: Pick<LogMeta, 'playedAt'>, name: string): string {
  const safe = name.replace(/[\\/\x00-\x1f]/g, '_')
  return meta.playedAt === null ? `logs/${UNDATED}/${safe}` : `logs/${schoolYear(meta.playedAt)}/${dayText(meta.playedAt)}/${safe}`
}

/** The same path with the content's first 8 hex digits before the extension: used when another log already has the path. */
export function withShaSuffix(path: string, sha256: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  const tag = `-${sha256.slice(0, 8)}`
  return dot > slash ? `${path.slice(0, dot)}${tag}${path.slice(dot)}` : `${path}${tag}`
}

/** The last part of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
