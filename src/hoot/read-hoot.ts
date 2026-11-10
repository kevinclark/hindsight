/**
 * One .hoot read through owlet into what the device view draws, kept in a cache outside the library (Sync uploads every
 * library record; this is derived data, never shared). Main process only.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { busOf, lastWords, parseScan, runOutcome, runOwlet, SIGNAL_SET, wantedIds, type FoundOwlet } from './owlet.ts'
import { reduceExport } from './reduce.ts'
import type { HootReading } from './types.ts'

/** Bump when reduceExport changes what it keeps: every cached reading is then read again. */
export const READING_VERSION = 2

export interface ReadHootOptions {
  owlet: FoundOwlet
  /** The command that runs it (the owlet's path; the tests put a fake behind node). */
  argv: string[]
  hootPath: string
  fileName: string
  /** The library's sha-256 of the .hoot: a changed file is a different reading. */
  sha256: string
  cacheDir: string
  /** A folder for owlet's export (about 1.8x the .hoot), made and removed by this read. */
  tempRoot: string
  onPercent?: (p: number) => void
  signal?: AbortSignal
  log?: (line: string) => void
  /** Overridable for the tests. */
  stallMs?: number
  scanDeadlineMs?: number
}

export const cacheName = (sha256: string, owlet: Pick<FoundOwlet, 'version' | 'compliancy'>) =>
  `${sha256}-${owlet.version}-C${owlet.compliancy}-${SIGNAL_SET}-r${READING_VERSION}.json`

/** The reading this owlet made of this .hoot before, from the cache, or null: never runs owlet. */
export async function cachedHoot(o: Pick<ReadHootOptions, 'cacheDir' | 'sha256' | 'owlet'>): Promise<HootReading | null> {
  return readFile(join(o.cacheDir, cacheName(o.sha256, o.owlet)), 'utf8').then((t) => JSON.parse(t) as HootReading, () => null)
}

export async function readHoot(o: ReadHootOptions): Promise<HootReading & { cached: boolean }> {
  const cached = join(o.cacheDir, cacheName(o.sha256, o.owlet))
  const kept = await cachedHoot(o)
  if (kept) return { ...kept, cached: true }

  const size = (await stat(o.hootPath)).size
  const what = o.fileName
  const scanned = await runOwlet([...o.argv, '--scan', '-F', o.hootPath], { what, signal: o.signal, deadlineMs: o.scanDeadlineMs ?? 60_000 + size / 1_000 })
  const scan = parseScan(scanned.out)
  const scanOk = runOutcome(scanned, scan.ids.size > 0)
  if (!scanOk.ok) throw new Error(`Listing the signals in ${what}: ${scanOk.why}`)
  const ids = wantedIds(scan.ids)
  o.log?.(`${what}: ${scan.ids.size} signals, reading ${ids.length}${scan.cutShort ? ' (file ends early)' : ''}`)

  const about = { file: o.fileName, bus: busOf(o.fileName), owlet: `${o.owlet.version}-C${o.owlet.compliancy}` }
  if (ids.length === 0) return { ...about, start: 0, end: 0, enable: [], mode: [], fms: [], totalAmps: { t: [], a: [] }, devices: [], cutShort: scan.cutShort, cached: false }

  const dir = await mkdtemp(join(o.tempRoot, 'hindsight-hoot-'))
  try {
    const out = join(dir, 'export.wpilog')
    const run = await runOwlet([...o.argv, o.hootPath, out, '-f', 'wpilog', '-s', ids.join(',')], { what, signal: o.signal, stallMs: o.stallMs ?? 30_000, onPercent: o.onPercent })
    const wrote = ((await stat(out).catch(() => null))?.size ?? 0) > 0
    const outcome = runOutcome(run, wrote)
    if (!outcome.ok) throw new Error(`Reading ${what}: ${outcome.why}`)
    if (!wrote) throw new Error(`Reading ${what}: owlet finished but wrote nothing (${lastWords(run)})`)
    const reading = reduceExport(new Uint8Array(await readFile(out)), { ...about, cutShort: outcome.cutShort ?? scan.cutShort })
    await mkdir(o.cacheDir, { recursive: true })
    await writeFile(cached, JSON.stringify(reading))
    o.log?.(`${what}: ${reading.devices.length} devices, ${reading.enable.length} enable changes${reading.cutShort ? `; ${reading.cutShort}` : ''}`)
    return { ...reading, cached: false }
  } finally {
    // owlet's export is this read's own scratch file in the OS temp folder, not the user's data.
    await rm(dir, { recursive: true, force: true })
  }
}
