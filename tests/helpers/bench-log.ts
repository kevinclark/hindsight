/**
 * Build a bench-test .wpilog for the limits wizard from real CalGames spin-ups (fixtures/q13-spinups.json):
 * three runs, 10 s apart, as a student would record them with a supply limit set in Phoenix Tuner X.
 *
 * With a limit L, each motor's supply current is held at L (± 1.5 A of ripple, like a real limiter) and the run takes
 * longer: everything after the start is slowed by (current without the limit) ÷ (current with it) over the spin-up.
 * On the bench nothing else draws current, so the battery voltage is 12.6 V − 11 mΩ × the flywheel's current.
 * A model, not a measurement: good enough to drive the wizard's three paths, not to predict the real robot.
 */
import { readFileSync } from 'node:fs'
import { writeWpilog, type Fixture, type FixtureEntry } from './fixture-format.ts'

const SPIN_UPS = [302.13, 351.22, 371.73] // starts in Q13 (s)
const R_OHMS = 0.011
const RIPPLE = [-1.5, -0.5, 0.5, 1.5]
const BENCH_SETPOINT = 43

export interface BenchOptions {
  limitA: number | null
  /** A motor whose limit "didn't save": its current isn't held. */
  notSavedOn?: string
  /** Shift each run's battery voltage (V), e.g. [0, 0, -0.4] for a third run on a tired battery. */
  voltsOffset?: number[]
  /** Log a battery ID per run (as the battery tracker will), e.g. ['B07', 'B07', 'B03']. */
  batteryIds?: string[]
}

export function benchLog(opts: BenchOptions): Uint8Array {
  const fixture = JSON.parse(readFileSync('fixtures/q13-spinups.json', 'utf8')) as Fixture
  const byName = new Map(fixture.entries.map((e) => [e.name, e]))
  const supplyKeys = fixture.entries.filter((e) => e.name.endsWith('SupplyCurrentAmps')).map((e) => e.name)
  const out = new Map<string, FixtureEntry>(fixture.entries.map((e) => [e.name, { name: e.name, type: e.type, records: [] }]))
  SPIN_UPS.forEach((start, run) => {
    const benchStart = 10 + run * 10 // 10 s apart: room for a slower run and the wheel stopping
    const inRun = (t: number) => t >= start - 0.5 && t <= start + 3
    // How much slower the limit makes it: current without ÷ with the limit, over the first second of the spin-up.
    let without = 0, withLimit = 0
    for (const key of supplyKeys) {
      for (const [t, a] of byName.get(key)!.records as [number, number][]) {
        if (t < start || t > start + 1) continue
        without += a
        withLimit += opts.limitA === null || key.includes(opts.notSavedOn ?? '\u0000') ? a : Math.min(a, opts.limitA)
      }
    }
    const slower = withLimit > 0 ? without / withLimit : 1
    const benchTime = (t: number) => benchStart + (t < start ? t - start : (t - start) * slower)
    // The flywheel's total current at a time, with the limit applied.
    const currentAt = (t: number) => supplyKeys.reduce((sum, key) => {
      const recs = byName.get(key)!.records as [number, number][]
      const held = [...recs].reverse().find(([rt]) => rt <= t)?.[1] ?? 0
      return sum + (opts.limitA === null || key.includes(opts.notSavedOn ?? '\u0000') ? held : Math.min(held, opts.limitA))
    }, 0)
    for (const e of fixture.entries) {
      const target = out.get(e.name)!
      // Between runs the student lets the wheel stop: speed, current and applied voltage at zero 2 s before the run.
      if (/Velocity|SupplyCurrent|Leader\/Voltage/.test(e.name)) target.records.push([benchStart - 2, 0])
      let k = 0
      for (const [t, value] of e.records as [number, number][]) {
        if (!inRun(t)) continue
        let v = value
        if (supplyKeys.includes(e.name) && opts.limitA !== null && !e.name.includes(opts.notSavedOn ?? '\u0000') && v > opts.limitA) {
          v = opts.limitA + RIPPLE[k++ % RIPPLE.length]
        }
        if (e.name === '/SystemStats/BatteryVoltage') v = 12.6 - R_OHMS * currentAt(t) + (opts.voltsOffset?.[run] ?? 0)
        // ...and to the same setpoint.
        if (e.name.endsWith('/Setpoint')) v = BENCH_SETPOINT
        target.records.push([+benchTime(t).toFixed(4), v])
      }
    }
  })
  const ids: FixtureEntry[] = opts.batteryIds
    ? [{ name: '/RealOutputs/Battery/Id', type: 'string', records: opts.batteryIds.map((id, run) => [10 + run * 10 - 1, id]) }]
    : []
  const entries: FixtureEntry[] = [
    ...ids,
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[5, true]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, false]] },
    ...[...out.values()].map((e) => ({ ...e, records: e.records.sort((a, b) => (a[0] as number) - (b[0] as number)) })),
  ]
  return writeWpilog(entries)
}
