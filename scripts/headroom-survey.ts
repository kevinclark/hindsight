// Headroom on logs with no profile: every motor the builder finds with applied volts, velocity and stator current.
// For choosing Power -> Headroom's thresholds on other teams' robots, not only ours.
//   npx vite-node scripts/headroom-survey.ts <log.wpilog | folder> ...
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { motorsFromLog } from '../src/builder/motors.ts'
import { makeGrid, resample } from '../src/match/series.ts'
import { DT } from '../src/power/battery-model.ts'
import { motorHeadroom } from '../src/power/headroom.ts'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'

const files = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : p.endsWith('.wpilog') ? [p] : [])
const BUS = ['/SystemStats/BatteryVoltage', 'NT:/SystemStats/BatteryVoltage', 'DS:batteryVoltage', '/PowerDistribution/Voltage']
const ENABLED = ['/DriverStation/Enabled', 'DS:enabled', 'NT:/DriverStation/Enabled']
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '  –' : `${Math.round(100 * x)}%`.padStart(4))
for (const f of process.argv.slice(2).flatMap(files)) {
  let log
  try { log = openWpilog(new Uint8Array(readFileSync(f))) } catch { console.log(`\n== ${f}: not a readable .wpilog`); continue }
  const busKey = BUS.find((k) => log.entries.has(k)), enKey = ENABLED.find((k) => log.entries.has(k))
  const found = motorsFromLog(log).motors.filter((m) => m.appliedVolts && m.velocity && (m.statorCurrent ?? m.current))
  console.log(`\n== ${f.split('/').slice(-2).join('/')}  bus ${busKey ?? 'none'}  enabled ${enKey ?? 'none'}  motors with V+v+I: ${found.length}`)
  if (!busKey || !enKey || !found.length) continue
  const bus = readNumbers(log, busKey)!, en = readNumbers(log, enKey)!
  const t = makeGrid(bus.t[0], bus.t[bus.t.length - 1], DT)
  const B = resample(bus, t), E = Uint8Array.from(resample(en, t), (x) => (x ? 1 : 0))
  for (const m of found) {
    const get = (k?: string) => { const s = k ? readNumbers(log, k) : null; return s && s.t.length ? resample(s, t) : null }
    const volts = get(m.appliedVolts), velocity = get(m.velocity), stator = get(m.statorCurrent ?? m.current)
    if (!volts || !velocity || !stator) continue
    const flag = get(m.connected)
    const connected = flag ? Uint8Array.from(flag, (x) => (x === 0 ? 0 : 1)) : new Uint8Array(t.length).fill(1)
    const h = motorHeadroom(m.path, '', { volts, velocity, stator, connected }, B, E, { statorA: null, supplyA: null })
    const fit = h.fit ? `k ${h.fit.k.toPrecision(3)} R ${h.fit.ohms.toFixed(4)} rms ${h.fit.rmsVolts.toFixed(2)} n ${h.fit.samples}` : 'no fit'
    const top = h.topSpeed ? `top p50 ${h.topSpeed.p50.toFixed(2)} p90 ${h.topSpeed.p90.toFixed(2)} near ${pct(h.topSpeed.nearTop)} A@near ${h.ampsNearTop?.toFixed(0) ?? '–'}` : ''
    console.log(`  ${m.path.padEnd(42)} run ${h.runningSeconds.toFixed(0).padStart(4)} s  ${fit}  ${top}`)
  }
}
