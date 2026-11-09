/**
 * A stand-in for CTRE's owlet in the tests: never CTRE's binary, never a real .hoot. Its ".hoot" is a made-up file: 71
 * header bytes (byte 70 the compliancy, as in a real one) and then a JSON scenario. It answers `--scan -F <hoot>` with a
 * listing in owlet's shape and `<hoot> <out> -f wpilog -s <ids>` with a .wpilog of only those signals, written by
 * Hindsight's own writer, plus the Timestamp and ResetCount entries owlet adds per device.
 *
 * Run as `node --experimental-strip-types tests/helpers/fake-owlet.ts …` (see `fakeOwletArgv`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePayload, writeRecords, type RecordEntry } from '../../src/readers/wpilog-writer.ts'

export interface FakeSignal { type: 'double' | 'boolean' | 'int64' | 'string'; t: number[]; v: (number | boolean | string)[] }
export interface FakeHoot {
  compliancy: number
  /** By owlet's scan name: `RobotEnable`, `TalonFX-11/SupplyVoltage`. */
  signals: Record<string, FakeSignal>
  /** Added to every export, as owlet adds them (`TalonFX-11/ResetCount`). */
  automatic?: Record<string, FakeSignal>
  /** Print the cut-short line, write the output anyway, and exit 1. */
  cutShort?: boolean
  /** Never finish this command. */
  hang?: 'scan' | 'convert'
  /** Convert: print progress up to 40%, then the same 40% forever. */
  stuckAt40?: boolean
  /** Exit with this code and a message, writing nothing. */
  fail?: { code: number; message: string }
}

export function fakeHootBytes(h: FakeHoot): Uint8Array {
  const head = new Uint8Array(71)
  head[70] = h.compliancy
  const body = new TextEncoder().encode(JSON.stringify(h))
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

const idOf = (i: number) => (0x1ff00 + i * 0x100).toString(16)

function readFake(path: string): FakeHoot {
  return JSON.parse(new TextDecoder().decode(readFileSync(path).subarray(71))) as FakeHoot
}

function main(args: string[]): void {
  if (args[0] === '--scan') {
    const h = readFake(args[args.length - 1])
    if (h.hang === 'scan') { setInterval(() => {}, 1000); return }
    if (h.cutShort) process.stdout.write('Could not read to end of input file: Bad message\n')
    Object.keys(h.signals).forEach((name, i) => process.stdout.write(`${`${name}:`.padEnd(58)}${idOf(i)}\n`))
    process.exit(h.cutShort ? 1 : 0)
  }
  const [hoot, outPath] = args
  const h = readFake(hoot)
  if (h.fail) { process.stderr.write(`${h.fail.message}\n`); process.exit(h.fail.code) }
  if (h.hang === 'convert') { setInterval(() => {}, 1000); return }
  if (h.stuckAt40) { for (const p of [0, 20, 40]) process.stdout.write(`Progress: [ ${p}%] [...] `); setInterval(() => process.stdout.write('Progress: [ 40%] [...] '), 50); return }
  const ids = new Set((args[args.indexOf('-s') + 1] ?? '').split(','))
  const chosen = Object.entries(h.signals).filter((_, i) => ids.has(idOf(i)))
  const entries: RecordEntry[] = [...chosen, ...Object.entries(h.automatic ?? {})].map(([name, s]) => ({
    name: name.includes('/') ? `Phoenix6/${name}` : name, type: s.type, t: s.t,
    payload: s.v.map((v) => encodePayload(s.type, v)!),
  }))
  for (const p of [0, 50, 100]) process.stdout.write(`Progress: [${String(p).padStart(3)}%] [....] `)
  writeFileSync(outPath, writeRecords(entries))
  if (h.cutShort) { process.stdout.write('\nCould not read to end of input file: Operation timed out\n'); process.exit(1) }
  process.stdout.write(`\nOutput has been written to ${outPath}\n`)
}

/** The command that runs this fake as owlet. */
export const fakeOwletArgv = (): string[] => [process.execPath, '--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)]

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
