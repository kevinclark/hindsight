/**
 * Which Talon FX on the robot is which motor in the log, from a robot snapshot (tools/robot-snapshot.py).
 *
 * First by name: a device named in Phoenix Tuner X carries that name in the snapshot, and the motor's place in the
 * log usually says the same thing ("Flywheel Leader" against /Shooter/Flywheel/Leader). Then, when exactly one motor
 * and one Talon FX are left, they go together. Everything else is a dropdown the student sets.
 *
 * A device that still has Tuner X's default name ("Talon FX vers. C (Device ID 1)") has no words to match.
 */
import { busLabel, configOf, parseBool, parseNumber, type Device, type Snapshot } from '../snapshot/snapshot.ts'
import { LIMIT_FIELDS, sameNumber } from '../snapshot/report.ts'
import type { CurrentLimits } from '../profiles/types.ts'
import { tokens } from './groups.ts'

/** Words that say nothing about which motor it is. */
const GENERIC = new Set(['talon', 'fx', 'fxs', 'vers', 'version', 'c', 'device', 'id', 'motor', 'kraken', 'falcon', 'x44', 'x60', 'krakenx60', 'nt', 'telemetry', 'real', 'outputs', 'inputs', 'io', 'subsystem', 'module'])
const CORNER: Record<string, string[]> = { fl: ['front', 'left'], fr: ['front', 'right'], bl: ['back', 'left'], br: ['back', 'right'], rl: ['back', 'left'], rr: ['back', 'right'] }
const SAME: Record<string, string> = { rear: 'back', steer: 'turn', azimuth: 'turn', angle: 'turn', move: 'drive', lead: 'leader', follow: 'follower' }

/** The words of a name or path that could identify a motor, with corners spelled out and synonyms merged. */
export function nameWords(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of tokens(s)) {
    if (GENERIC.has(t)) continue
    for (const w of CORNER[t] ?? [SAME[t] ?? t]) out.add(SAME[w] ?? w)
  }
  return out
}

/** A Tuner X default name ("Talon FX vers. C (Device ID 1)"), or none. */
export const isDefaultName = (d: Device) => d.name.trim() === '' || /^Talon FX/i.test(d.name.trim()) && /Device ID\s*\d+/i.test(d.name)

export interface NameMatch { path: string; device: Device; score: number }

/**
 * Match motors (by their log path) to the snapshot's Talon FX by name. A motor gets a device when its best overlap
 * is clearly ahead of its second best and no other motor wants that device more. The score is the shared words over
 * the larger word set, so "Drive" alone doesn't take "Front Left Drive", plus a half for the words of the motor's own
 * name (the path's last part): in /Drive/FrontLeft/Turn the subsystem's "Drive" must not tie "FL Drive" with "FL Steer".
 */
export function matchByName(paths: string[], snapshot: Snapshot): NameMatch[] {
  const devices = snapshot.devices.filter((d) => d.isMotor && d.count === 1 && !isDefaultName(d))
  const score = (a: Set<string>, own: Set<string>, b: Set<string>) => {
    const shared = [...a].filter((w) => b.has(w)).length
    if (shared === 0) return 0
    return shared / Math.max(a.size, b.size) + (own.size ? (0.5 * [...own].filter((w) => b.has(w)).length) / own.size : 0)
  }
  const pairs: NameMatch[] = []
  for (const path of paths) {
    const pw = nameWords(path)
    const own = nameWords(path.split('/').filter(Boolean).at(-1) ?? '')
    const ranked = devices.map((device) => ({ device, s: score(pw, own, nameWords(device.name)) })).sort((x, y) => y.s - x.s)
    if (ranked.length && ranked[0].s > 0 && (ranked.length === 1 || ranked[0].s > ranked[1].s)) pairs.push({ path, device: ranked[0].device, score: ranked[0].s })
  }
  // One device per motor: when two motors pick one device, the better score keeps it; a tie keeps neither.
  const byDevice = new Map<string, NameMatch[]>()
  for (const p of pairs) { const k = p.device.key; if (!byDevice.has(k)) byDevice.set(k, []); byDevice.get(k)!.push(p) }
  const out: NameMatch[] = []
  for (const ps of byDevice.values()) {
    ps.sort((a, b) => b.score - a.score)
    if (ps.length === 1 || ps[0].score > ps[1].score) out.push(ps[0])
  }
  return out
}

/** The current limits a Talon FX is running, read from the snapshot. Null fields were missing or unreadable. */
export function appliedLimits(device: Device): Partial<Record<keyof CurrentLimits, number | boolean | null>> {
  const out: Partial<Record<keyof CurrentLimits, number | boolean | null>> = {}
  for (const spec of LIMIT_FIELDS) {
    const c = configOf(device, spec.signal)
    out[spec.key] = c ? (spec.kind === 'bool' ? parseBool(c.value) : parseNumber(c.value)) : null
  }
  return out
}

/**
 * A group's limits from its motors' applied ones, when every motor was read and they agree. Otherwise the fields on
 * which they disagree (or that couldn't be read), so the builder can say so.
 */
export function groupLimits(devices: Device[], snapshot: Snapshot): { limits: CurrentLimits } | { problem: string } {
  if (devices.length === 0) return { problem: 'no motor in this group has a CAN ID yet' }
  const read = devices.map((d) => ({ d, l: appliedLimits(d) }))
  const unread = read.filter((r) => !r.d.configs)
  if (unread.length) return { problem: `the snapshot didn't read the configs of ${unread.map((r) => `${r.d.model} ${r.d.id}`).join(', ')}` }
  const limits: CurrentLimits = { where: `as running on the robot (snapshot ${snapshot.takenAtLocal || snapshot.takenAt})` }
  const differ: string[] = []
  for (const spec of LIMIT_FIELDS) {
    const values = read.map((r) => r.l[spec.key])
    if (values.some((v) => v === null || v === undefined)) { differ.push(`${spec.label} unreadable`); continue }
    const first = values[0]!
    const agree = values.every((v) => (spec.kind === 'bool' ? v === first : sameNumber(v as number, first as number)))
    if (!agree) { differ.push(`${spec.label}: ${read.map((r) => `${r.d.id} ${r.l[spec.key]}`).join(', ')}`); continue }
    ;(limits as unknown as Record<string, unknown>)[spec.key] = first
  }
  return differ.length ? { problem: `this group's motors don't run the same limits (${differ.join('; ')}): split the group, or fix the motors` } : { limits }
}

export const deviceLabel = (d: Device) => `${d.id} on the ${busLabel(d.bus)}${isDefaultName(d) ? '' : ` ("${d.name}")`}`
