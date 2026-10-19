/**
 * Reference numbers for the Limits tab, computed a second, simpler way so the app's numbers can be checked.
 * A TypeScript port of 8033/robot/hindsight-research/whatif/current_limit_check.py that reads the .wpilog directly
 * (the Python reads a local pickle): every signal is held onto a 5 ms grid, and "over the limit" means more than
 * 5 A above it, as in the Python.
 *
 *   node --experimental-strip-types scripts/limits-reference.ts <log.wpilog> [...]
 */
import { readFileSync } from 'node:fs'
import { openWpilog, readNumbers, type WpilogFile } from '../src/readers/wpilog.ts'

const DT = 0.005

/**
 * Seconds a signal spent above `threshold`, and its longest run, on a 5 ms hold-last grid. As in the Python, the grid
 * runs from the later to the earlier of the first/last records of the signal and its partner (stator for supply).
 */
export function overThreshold(log: WpilogFile, key: string, threshold: number, partnerKey?: string): { seconds: number; longest: number } | null {
  const s = readNumbers(log, key)
  if (!s || s.t.length < 2) return null
  const p = partnerKey ? readNumbers(log, partnerKey) : null
  const start = Math.max(s.t[0], p?.t[0] ?? -Infinity)
  const end = Math.min(s.t[s.t.length - 1], p ? p.t[p.t.length - 1] : Infinity)
  let seconds = 0, run = 0, longest = 0, j = 0
  const n = Math.ceil((end - start) / DT)
  for (let k = 0; k < n; k++) {
    const t = start + k * DT
    while (j + 1 < s.t.length && s.t[j + 1] <= t) j++
    if (Math.abs(s.v[j]) > threshold) { seconds += DT; run += DT; longest = Math.max(longest, run) } else run = 0
  }
  return { seconds, longest }
}

export const REFERENCE_KEYS = {
  flywheel: ['/Drum/Flywheel/Leader/SupplyCurrentAmps', ...[0, 1, 2].map((i) => `/Drum/Flywheel/Follower ${i}/SupplyCurrentAmps`)],
  drive: ['Front Left', 'Front Right', 'Back Left', 'Back Right'].map((m) => `/Swerve/${m} Module/DriveSupplyCurrentAmps`),
}

if (process.argv[1]?.endsWith('limits-reference.ts')) {
  for (const path of process.argv.slice(2)) {
    const log = openWpilog(new Uint8Array(readFileSync(path)))
    console.log(path.split('/').pop())
    for (const [group, keys] of Object.entries(REFERENCE_KEYS)) {
      for (const key of keys) {
        const r = overThreshold(log, key, 45, key.replace('Supply', 'Stator')) // 40 A supply limit + 5 A
        console.log(`  ${group.padEnd(8)} ${key.padEnd(50)} > 45 A: ${r ? r.seconds.toFixed(2) : '—'} s, longest ${r ? r.longest.toFixed(2) : '—'} s`)
      }
    }
  }
}
