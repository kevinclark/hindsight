/**
 * What power/battery-collapse says on each match log, with the numbers behind it: for checking a change to the healthy
 * battery reference (src/power/fleet-reference.ts) against every match before and after.
 *
 *   node --experimental-strip-types scripts/battery-backtest.ts <out.json> <log> [<log> ...]
 *
 * Prints one line per log: the rule's verdict (fires / partly checked / quiet / not checked), charge drawn by the match's
 * end, resistance, the estimated open-circuit voltage at a few charges, brownout onsets (all, and in the last 30 s of the
 * match) and whether the log names its battery. The JSON adds each log's whole open-circuit curve (0.5 Ah bins), the
 * input for building the reference. The battery's name itself is never printed or written: names can be people's.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { analyzeFiles } from '../src/analyze.ts'
import { batteryAt } from '../src/match/battery-id.ts'
import { ocvCurve } from '../src/power/battery-model.ts'
import { MatchView } from '../src/rules/view.ts'

const [out, ...paths] = process.argv.slice(2)
if (!out || paths.length === 0) throw new Error('usage: battery-backtest.ts <out.json> <log> [<log> ...]')

const ID = 'power/battery-collapse'
const rows: Record<string, unknown>[] = []
for (const path of paths) {
  const name = path.split('/').pop()!
  let analyses
  try {
    ({ analyses } = analyzeFiles([{ name, bytes: new Uint8Array(readFileSync(path)) }]))
  } catch (e) {
    console.error(`${name}: ${(e as Error).message}`)
    continue
  }
  for (const a of analyses) {
    const view = new MatchView(a.match)
    const found = a.report.findings.find((f) => f.rule === ID)
    const skipped = a.report.skipped.find((s) => s.rule === ID)
    const verdict = found ? `fires ${found.severity}: ${found.title}` : skipped ? (skipped.reason.startsWith('partly') ? `partly: ${skipped.reason}` : `not checked: ${skipped.reason}`) : 'quiet'
    const power = view.powerIfLogged()
    const ohms = power?.report.resistanceOhms ?? null
    const curve = power && ohms !== null ? ocvCurve(power.grid, ohms, 0.5) : []
    const end = power?.grid.ah[power.grid.ah.length - 1] ?? NaN
    const at = (ah: number) => curve.find((p) => p.ah === ah)?.volts ?? NaN
    const onsets = view.signalIfLogged('brownedOut')?.turnsOn() ?? []
    const late = view.matchEnd === null ? 0 : onsets.filter((t) => t >= view.matchEnd! - 30 && t <= view.matchEnd!).length
    const batteryName = a.match.matchStart === null ? undefined : batteryAt(a.match, a.match.matchStart)?.id
    rows.push({
      file: name, profile: a.match.profile.name, verdict,
      ahAtEnd: +end.toFixed(2), milliohms: ohms === null ? null : +(ohms * 1000).toFixed(1),
      ocv6_25: at(6.25), ocv7_25: at(7.25), ocv8_25: at(8.25),
      brownouts: onsets.length, brownoutsLast30s: late,
      firstBrownoutAh: onsets.length && power ? +power.grid.ah[Math.min(power.grid.t.length - 1, Math.max(0, Math.round((onsets[0] - power.grid.t[0]) / 0.02)))].toFixed(2) : null,
      onField: view.onField,
      // A short hash, so matches on one battery can be grouped without writing its name.
      battery: batteryName ? createHash('sha256').update(batteryName).digest('hex').slice(0, 6) : null,
      curve,
    })
    const r = rows[rows.length - 1]
    console.log([name, r.verdict, `${r.ahAtEnd} Ah`, `${r.milliohms} mΩ`, `8.25 Ah ${Number.isFinite(r.ocv8_25) ? (r.ocv8_25 as number).toFixed(2) : '-'} V`, `brownouts ${r.brownouts} (last 30 s ${r.brownoutsLast30s})`, `battery ${r.battery ?? '-'}`].join(' | '))
  }
}
writeFileSync(out, JSON.stringify(rows, null, 1))
