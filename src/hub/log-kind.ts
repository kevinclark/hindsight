/**
 * What an off-the-field robot log is, from the runs its reading holds (ADR 8): an on-check (the robot was enabled for at least
 * a second: the pit's routine), a log that was never enabled, or one whose runs were not read yet. Pure, no `node:` imports.
 * It names logs for the Library's "Log type" filter and the phone's rows; no rule reads it.
 */
import type { LogRecord } from './types.ts'

export type OffFieldKind = 'on-check' | 'not-enabled' | 'unread'

/** A run shorter than this is the robot being switched on and off, not driven. */
export const MIN_RUN_SECONDS = 1

type Reading = Pick<LogRecord, 'kind' | 'onField' | 'runs'>

/** The kind of an off-the-field robot .wpilog; null on the field, and for any other file. */
export function offFieldKind(r: Reading): OffFieldKind | null {
  if (r.kind !== 'wpilog' || r.onField) return null
  if (!r.runs) return 'unread'
  return r.runs.seconds.some((s) => s >= MIN_RUN_SECONDS) ? 'on-check' : 'not-enabled'
}

/** Seconds enabled: the runs of a second or more, added; 0 when the log has no runs reading. */
export const enabledSeconds = (r: Pick<LogRecord, 'runs'>): number => (r.runs?.seconds ?? []).filter((s) => s >= MIN_RUN_SECONDS).reduce((a, b) => a + b, 0)
