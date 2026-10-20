/**
 * One log key per signal, for one match. A log type's signal map may list several places a signal can be, in order
 * (AdvantageKit's key, then DataLogManager's, then the Driver Station log's): a match uses the first its logs have.
 * Rules never see the list: they ask for a signal by name, and the framework says on a finding when it came from
 * somewhere other than the robot log.
 *
 * The Driver Station log is a source like any other, written `dslog:<field>` with a field of its records
 * (readers/dslog.ts), e.g. `dslog:brownout`.
 */
import type { SignalKeys, SignalSources, Source } from './types.ts'

export const DSLOG = 'dslog:'

export const isDslogKey = (key: string) => key.startsWith(DSLOG)

/** Signals whose value is a list of keys that are all read (not alternatives). */
const LISTS = new Set<string>(['alertGroups', 'joystickButtonCounts'] satisfies (keyof SignalKeys)[])

/** Each signal's first source that `present` says the logs have. */
export function resolveSignals(signals: SignalSources, present: (key: string) => boolean): SignalKeys {
  const out: Record<string, unknown> = {}
  for (const [name, source] of Object.entries(signals)) out[name] = LISTS.has(name) ? source : pick(source as Source, present)
  return out as unknown as SignalKeys
}

/**
 * The first key the logs have. With none, the first non-empty key: the robot log's when there is one (so "missing"
 * names the key a student can add), else the Driver Station log's (so it says to load the .dslog).
 */
function pick(source: Source, present: (key: string) => boolean): string {
  const keys = keysOf(source)
  return keys.find((k) => k !== '' && present(k)) ?? keys.find((k) => k !== '') ?? ''
}

/** Every key a signal map names, in order, lists flattened. */
export function keysOf(source: Source | string[]): string[] {
  return typeof source === 'string' ? [source] : source
}
