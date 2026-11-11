/**
 * What an off-the-field robot log is, from the runs its reading holds (ADR 8): an on-check (some run of at least a second:
 * the pit's routine), a brief one (enabled, every run under a second), a log that was never enabled, or one with no runs
 * reading (not read yet, or the log records no Enabled signal). Pure, no `node:` imports.
 * It names logs for the Library's "Log type" filter and the phone's rows; no rule reads it.
 */
import type { LogRecord } from './types.ts'

export type OffFieldKind = 'on-check' | 'brief' | 'not-enabled' | 'unread'

/** A run shorter than this is the robot being switched on and off, not driven. */
export const MIN_RUN_SECONDS = 1

type Reading = Pick<LogRecord, 'kind' | 'onField' | 'runs'>

/** The kind of an off-the-field robot .wpilog; null on the field, and for any other file. */
export function offFieldKind(r: Reading): OffFieldKind | null {
  if (r.kind !== 'wpilog' || r.onField) return null
  if (!r.runs) return 'unread'
  if (r.runs.count === 0) return 'not-enabled'
  return r.runs.seconds.some((s) => s >= MIN_RUN_SECONDS) ? 'on-check' : 'brief'
}

/** Seconds enabled: the runs of a second or more, added; 0 when the log has no runs reading. */
export const enabledSeconds = (r: Pick<LogRecord, 'runs'>): number => (r.runs?.seconds ?? []).filter((s) => s >= MIN_RUN_SECONDS).reduce((a, b) => a + b, 0)
