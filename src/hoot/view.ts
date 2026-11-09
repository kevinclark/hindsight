/**
 * The Devices tab's model: each device of each .hoot as one row, named from the robot profile where it can be, with the
 * numbers beside its strip. Pure; the page draws it (src/ui/DevicesTab.svelte).
 */
import type { ResolvedProfile } from '../profiles/types.ts'
import { namedTime } from '../hub/catalog.ts'
import { hootName } from '../hub/dates.ts'
import type { HootDevice, HootReading } from './types.ts'

export interface DeviceRow {
  device: HootDevice
  /** "Flywheel leader · TalonFX-12", or owlet's name alone. */
  label: string
  lowestVolts: number | null
  peakAmps: number | null
  peakTemp: number | null
  /** Fault turn-ons and restarts, in time order. */
  events: { t: number; what: string }[]
}

/** The robot's stretches of enabled time on the .hoot's own clock (its RobotEnable). */
export function enabledSpans(r: HootReading): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const e of r.enable) {
    if (e.on && (out.length === 0 || Number.isFinite(out[out.length - 1].end))) out.push({ start: e.t, end: Infinity })
    else if (!e.on && out.length && !Number.isFinite(out[out.length - 1].end)) out[out.length - 1].end = e.t
  }
  if (out.length && !Number.isFinite(out[out.length - 1].end)) out[out.length - 1].end = r.end
  return out
}

const inside = (t: number, spans: { start: number; end: number }[]) => spans.some((s) => t >= s.start && t < s.end)

/** The extreme of `values` over bins inside the spans (all bins when `spans` is null). */
function extreme(t: number[], values: number[] | null, spans: { start: number; end: number }[] | null, pick: (a: number, b: number) => number): number | null {
  if (!values) return null
  let out: number | null = null
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(values[i]) || (spans && !inside(t[i], spans))) continue
    out = out === null ? values[i] : pick(out, values[i])
  }
  return out
}

/**
 * Each device as a row. Lowest voltage and peak current are over enabled time (the .hoot's own RobotEnable, so they exist
 * even when the file can't be lined up with the robot log); temperature over the whole file. Rows with a fault or a restart
 * come first, earliest first; then the lowest voltage first.
 */
export function deviceRows(r: HootReading, names: Map<string, string>): DeviceRow[] {
  const spans = enabledSpans(r)
  const rows = r.devices.map((device): DeviceRow => ({
    device,
    label: names.has(device.name) ? `${names.get(device.name)} · ${device.name}` : device.name,
    lowestVolts: extreme(device.t, device.volts, spans, Math.min),
    peakAmps: extreme(device.t, device.amps, spans, Math.max),
    peakTemp: device.temp ? extreme(device.temp.t, device.temp.c, null, Math.max) : null,
    events: [...device.faults.map((f) => ({ t: f.on, what: f.name })), ...device.resets.map((t) => ({ t, what: 'restarted' }))].sort((a, b) => a.t - b.t),
  }))
  const firstEvent = (row: DeviceRow) => row.events[0]?.t ?? Infinity
  return rows.sort((a, b) => firstEvent(a) - firstEvent(b) || (a.lowestVolts ?? Infinity) - (b.lowestVolts ?? Infinity))
}

/**
 * Names from the robot profile: a motor by its CAN id when exactly one motor of the profile has that id and exactly one of
 * this log's .hoot files holds a TalonFX with it (the profile names no CAN bus); CANcoders and the Pigeon 2 from the
 * profile's Foresight snapshot devices the same way.
 */
export function profileNames(profile: Pick<ResolvedProfile, 'motorGroups' | 'foresight'>, readings: HootReading[]): Map<string, string> {
  const candidates = new Map<string, string[]>()
  const add = (device: string, name: string) => candidates.set(device, [...(candidates.get(device) ?? []), name])
  for (const g of profile.motorGroups) for (const m of g.motors) if (m.canId !== undefined) add(`TalonFX-${m.canId}`, m.name)
  for (const d of profile.foresight?.snapshot?.devices ?? []) add(`${d.model === 'Pigeon 2' ? 'Pigeon2' : 'CANcoder'}-${d.canId}`, d.name)
  const held = new Map<string, number>()
  for (const r of readings) for (const d of r.devices) held.set(d.name, (held.get(d.name) ?? 0) + 1)
  return new Map([...candidates].filter(([device, names]) => names.length === 1 && held.get(device) === 1).map(([device, names]) => [device, names[0]]))
}

/** Whether the line from the bin at `a` to the bin at `b` crosses a gap: a gap's ends are record times inside the bins on either side. */
export const crossesGap = (gaps: { from: number; to: number }[], a: number, b: number, bin: number): boolean =>
  gaps.some((g) => g.from >= a && g.to <= b + bin)

const dayOf = (ms: number) => Math.floor(ms / 86_400_000)

/**
 * What the Devices tab says about a .hoot that is itself the opened log (a hoot-only entry), in place of any lining up: that
 * it is the log when it shares the opened file's name time ("This log is the .hoot itself."), and the nearest other .hoot on
 * the same bus whose name time is later the same day, with how long after this one's end it starts (its name time minus this
 * name time plus the reading's `end`; whole seconds; no threshold, a negative number says the next file started first).
 * `others`: the file names of every other .hoot in the library.
 */
/** Seconds as a reader counts them: whole seconds under two minutes, else whole minutes. */
const afterWords = (s: number) => (Math.abs(s) < 120 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`)

export function hootOwnNotes(reading: Pick<HootReading, 'file' | 'bus' | 'end'>, opened: string, others: string[]): string[] {
  const at = namedTime(reading.file)
  const notes: string[] = []
  if (reading.file === opened || (at !== null && at === namedTime(opened))) notes.push('This log is the .hoot itself.')
  if (at === null) return notes
  const next = others
    .filter((name) => name !== reading.file && hootName(name)?.hardwareId === reading.bus)
    .flatMap((name) => { const t = namedTime(name); return t !== null && t > at && dayOf(t) === dayOf(at) ? [{ name, t }] : [] })
    .sort((a, b) => a.t - b.t)[0]
  if (next) notes.push(`Another file on this bus starts ${afterWords((next.t - (at + reading.end * 1000)) / 1000)} after this one ends: ${next.name}.`)
  return notes
}
