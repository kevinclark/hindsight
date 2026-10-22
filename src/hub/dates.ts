/**
 * The time in an AdvantageKit file name (akit_YY-MM-DD_HH-MM-SS…). It is UTC in 2026 logs and Pacific in the 2024-25
 * ones (three events, 8033 notes), so a name from 2025 or earlier is read as Pacific. Assumed from those events: a
 * robot team elsewhere would set `zoneFor`. Only used when the robot clock was never set (describe.ts).
 */

const PACIFIC = 'America/Los_Angeles'

/** Until this year (inclusive) a file name's time was the roboRIO's local time on the west coast. */
export const LAST_PACIFIC_YEAR = 2025

export function nameInstant(name: string, zoneFor: (year: number) => string = (y) => (y <= LAST_PACIFIC_YEAR ? PACIFIC : 'UTC')): number | null {
  const m = /(\d{2})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name)
  if (!m) return null
  const [yy, mo, d, h, mi, s] = m.slice(1).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const year = 2000 + yy
  return wallToInstant(year, mo, d, h, mi, s, zoneFor(year))
}

/** The instant (ms) at which the clock in `zone` read this wall time. */
export function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  if (!Number.isFinite(guess)) return null
  if (zone === 'UTC') return guess
  // Two passes: the offset at the guess, then at the corrected instant (a daylight-saving change in between).
  const first = guess - offsetMs(guess, zone)
  return guess - offsetMs(first, zone)
}

function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000
}

/**
 * A Phoenix .hoot name: "<rio or CANivore serial>_2026-10-17_20-07-34[_more].hoot". The time is read as UTC (assumed:
 * not yet compared with a hoot log's own clock).
 */
export function hootName(name: string): { hardwareId: string; at: number } | null {
  const m = /^(.+?)_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name)
  if (!m) return null
  const [, id, y, mo, d, h, mi, s] = m
  const at = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  return Number.isFinite(at) ? { hardwareId: id, at } : null
}
