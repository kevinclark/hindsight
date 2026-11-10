/**
 * Which battery was in the robot: the battery tracker's ID (the profile's `battery.id`), else the name the battery's fuel
 * gauge reports (`battery.gaugeName`, which a robot may log once at start-up as AdvantageKit metadata). One place, so the
 * Library, the Session view and battery/identity agree on a log's battery.
 */
import { has, values, type Match } from './match.ts'
import { heldAt } from './series.ts'
import type { BatteryKeys } from '../profiles/types.ts'

export interface BatteryName {
  id: string
  /** Where the name came from: the tracker's ID key, or the gauge's own name key. */
  from: 'tracker' | 'gauge'
}

/** The battery at time `t` (the value held then, or the first one when every record is later), or null when neither key names one. */
export function batteryAt(match: Match, t: number): BatteryName | null {
  const battery = match.profile.battery as BatteryKeys
  const id = textAt(match, battery.id, t)
  if (id) return { id, from: 'tracker' }
  const name = textAt(match, battery.gaugeName, t)
  return name ? { id: name, from: 'gauge' } : null
}

/** The text a key held at `t`, trimmed; a key logged only after `t` (metadata stamps vary) gives its first value. */
function textAt(match: Match, key: string, t: number): string {
  if (!key || !has(match, key)) return ''
  const s = values<string>(match, key)
  if (!s || s.v.length === 0) return ''
  const v = heldAt(s, t) ?? s.v[0]
  return typeof v === 'string' ? v.trim() : ''
}
