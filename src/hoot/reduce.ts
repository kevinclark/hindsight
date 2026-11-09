/**
 * owlet's wpilog export of a .hoot, reduced to what the device view draws (src/hoot/types.ts). The export is ~1.8x the
 * .hoot even with only the wanted signals, so nothing else of it is kept. Pure: the main process hands in the opened file.
 */
import { openWpilog, readNumbers, readValues, type WpilogFile } from '../readers/wpilog.ts'
import { makeGrid, type NumberSeries } from '../match/series.ts'
import { DT } from '../power/battery-model.ts'
import { BIN_S, GAP_S, TEMP_BIN_S, type HootDevice, type HootReading } from './types.ts'

/** owlet's names in the export: `Phoenix6/TalonFX-11/SupplyVoltage`. */
const DEVICE_KEY = /^Phoenix6\/([A-Za-z0-9]+-\d+)\/(.+)$/

export function reduceExport(bytes: Uint8Array, about: Pick<HootReading, 'file' | 'bus' | 'cutShort' | 'owlet'>): HootReading {
  const log = openWpilog(bytes)
  const signals = new Map<string, Set<string>>()
  for (const name of log.entries.keys()) {
    const m = DEVICE_KEY.exec(name)
    if (m) signals.set(m[1], (signals.get(m[1]) ?? new Set()).add(m[2]))
  }
  const start = log.firstTime
  const end = log.lastTime
  const devices = [...signals].map(([name, has]) => readDevice(log, name, has, start, end)).sort((a, b) => byDeviceName(a.name, b.name))
  const modes = readValues<string>(log, 'RobotMode')
  const mode: HootReading['mode'] = []
  if (modes) for (let i = 0; i < modes.t.length; i++) if (i === 0 || modes.v[i] !== modes.v[i - 1]) mode.push({ t: modes.t[i], v: String(modes.v[i]) })
  return {
    ...about, start, end,
    enable: changes(readNumbers(log, 'RobotEnable')).map((c) => ({ t: c.t, on: c.v !== 0 })),
    mode,
    fms: changes(readNumbers(log, 'DS:IsFMSAttached')).map((c) => ({ t: c.t, on: c.v !== 0 })),
    totalAmps: totalSupplyCurrent(log, [...signals].filter(([name, has]) => name.startsWith('TalonFX-') && has.has('SupplyCurrent')).map(([name]) => name), start, end),
    devices,
  }
}

/**
 * The sum of every TalonFX's supply current on the 0.02 s grid (DT) from `start` to `end`: at each grid time each device's
 * last record at or before it; 0 A before its first record and inside its gaps (`gapsIn`, the same rule the strips break on).
 */
export function totalSupplyCurrent(log: WpilogFile, talons: string[], start: number, end: number): { t: number[]; a: number[] } {
  const grid = makeGrid(start, end, DT)
  const sums = new Float64Array(grid.length)
  for (const name of talons) {
    const s = readNumbers(log, `Phoenix6/${name}/SupplyCurrent`)
    if (!s) continue
    const gaps = gapsIn(s.t, start, end)
    let j = -1
    let g = 0
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i]
      while (j + 1 < s.t.length && s.t[j + 1] <= t) j++
      while (g < gaps.length && gaps[g].to <= t) g++
      const inGap = g < gaps.length && t > gaps[g].from && t < gaps[g].to
      if (j >= 0 && !inGap && Number.isFinite(s.v[j])) sums[i] += s.v[j]
    }
  }
  return { t: Array.from(grid, (x) => Math.round(x * 1e6) / 1e6), a: Array.from(sums, (x) => Math.round(x * 100) / 100) }
}

function readDevice(log: WpilogFile, name: string, has: Set<string>, start: number, end: number): HootDevice {
  const read = (signal: string) => (has.has(signal) ? readNumbers(log, `Phoenix6/${name}/${signal}`) : null)
  const volts = read('SupplyVoltage')
  const amps = read('SupplyCurrent')
  const temp = read('DeviceTemp') ?? read('Temperature')
  const supply = binned([volts && { s: volts, keep: Math.min }, amps && { s: amps, keep: Math.max }], BIN_S)
  const temps = temp ? binned([{ s: temp, keep: Math.max }], TEMP_BIN_S) : null
  const faults = [...has].filter((s) => s.startsWith('Fault_')).sort().flatMap((s) => onOff(read(s)!).map((x) => ({ name: s.slice('Fault_'.length), ...x })))
  const resetCount = read('ResetCount')
  const resets = resetCount ? changes(resetCount).filter((c, i, all) => i > 0 && c.v > all[i - 1].v).map((c) => c.t) : []
  const densest = [volts, amps, temp].filter((s) => s !== null).sort((a, b) => b.t.length - a.t.length)[0] ?? null
  return {
    name, t: supply.t, volts: volts ? supply.values[0]! : null, amps: amps ? supply.values[1]! : null,
    temp: temps ? { t: temps.t, c: temps.values[0]! } : null,
    gaps: densest ? gapsIn(densest.t, start, end) : [], faults, resets,
  }
}

/**
 * Several series on one set of bins of `width` seconds: each bin keeps one value per series (the lowest or the highest of
 * its records, so an extreme is never smoothed away). A bin no series has a record in is left out.
 */
export function binned(list: ({ s: NumberSeries; keep: (a: number, b: number) => number } | null)[], width: number): { t: number[]; values: (number[] | null)[] } {
  const bins = new Map<number, (number | null)[]>()
  list.forEach((item, k) => {
    if (!item) return
    for (let i = 0; i < item.s.t.length; i++) {
      const v = item.s.v[i]
      if (!Number.isFinite(v)) continue
      const b = Math.floor(item.s.t[i] / width)
      const row = bins.get(b) ?? list.map(() => null)
      row[k] = row[k] === null ? v : item.keep(row[k]!, v)
      bins.set(b, row)
    }
  })
  const order = [...bins.keys()].sort((a, b) => a - b)
  const round = (x: number) => Math.round(x * 1000) / 1000
  return {
    t: order.map((b) => round(b * width)),
    // A bin another series filled holds NaN for this one; the strip and the numbers skip NaN.
    values: list.map((item, k) => (item ? order.map((b) => bins.get(b)![k] ?? NaN) : null)),
  }
}

/** Each record where the value differs from the one before (the first record always counts). */
export function changes(s: NumberSeries | null): { t: number; v: number }[] {
  if (!s) return []
  const out: { t: number; v: number }[] = []
  for (let i = 0; i < s.t.length; i++) if (i === 0 || s.v[i] !== s.v[i - 1]) out.push({ t: s.t[i], v: s.v[i] })
  return out
}

/** A 0/1 signal's stretches of 1: when each began and ended (null: still on at the last record). */
export function onOff(s: NumberSeries): { on: number; off: number | null }[] {
  const out: { on: number; off: number | null }[] = []
  for (const c of changes(s)) {
    if (c.v !== 0 && (out.length === 0 || out[out.length - 1].off !== null)) out.push({ on: c.t, off: null })
    else if (c.v === 0 && out.length && out[out.length - 1].off === null) out[out.length - 1].off = c.t
  }
  return out
}

/**
 * Stretches with no record: longer than GAP_S and than five of the device's usual intervals (a slow signal is not a gap),
 * including before its first and after its last record within the file.
 */
export function gapsIn(t: ArrayLike<number>, start: number, end: number): { from: number; to: number }[] {
  if (t.length === 0) return [{ from: start, to: end }]
  const steps: number[] = []
  for (let i = 1; i < t.length; i++) steps.push(t[i] - t[i - 1])
  const usual = steps.length ? [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0
  const limit = Math.max(GAP_S, 5 * usual)
  const edges = [start, ...Array.from(t), end]
  const out: { from: number; to: number }[] = []
  for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > limit) out.push({ from: edges[i - 1], to: edges[i] })
  return out
}

/** TalonFX-2 before TalonFX-11: by kind, then by number. */
export function byDeviceName(a: string, b: string): number {
  const [ka, na] = a.split('-')
  const [kb, nb] = b.split('-')
  return ka.localeCompare(kb) || Number(na) - Number(nb)
}
