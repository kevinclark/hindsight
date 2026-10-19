// Scratch exploration: print facts about a log for calibrating rules. Not part of the app.
import { readFileSync } from 'node:fs'
import { openWpilog, readNumbers, readValues } from '../src/readers/wpilog.ts'

const path = process.argv[2]
const names = process.argv.slice(3)
const t0 = performance.now()
const log = openWpilog(new Uint8Array(readFileSync(path)))
console.log(`indexed ${log.recordCount} records, ${log.entries.size} entries in ${(performance.now() - t0).toFixed(1)} ms`, log.warnings)
for (const n of names) {
  const e = log.entries.get(n)
  if (!e) { console.log('MISSING', n); continue }
  let s: any
  try { s = readNumbers(log, n) } catch { s = readValues(log, n) }
  const vals = Array.from(s.v as ArrayLike<unknown>)
  console.log(`${n} [${e.type}] n=${vals.length}`)
  const lim = Number(process.env.LIM ?? 40)
  for (let i = 0; i < Math.min(vals.length, lim); i++) console.log('  ', s.t[i].toFixed(3), JSON.stringify(vals[i]))
}
