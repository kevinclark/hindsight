/**
 * The phone layout without a Drive: `?phone-fixture` in a dev build installs the phone's hub over the invented event in
 * fixtures/phone/event.json (scripts/phone-fixture.ts), so the phone pages can be seen and screenshotted. Dev only: main.ts
 * imports it only when `import.meta.env.DEV`.
 */
import type { FileInfo } from './hub/adapter.ts'
import { sha256Hex, type ReadStore } from './hub/phone-cache.ts'
import { serializeRecord, type LogRecord } from './hub/types.ts'
import { installPhoneOver } from './phone.ts'
import fixture from '../fixtures/phone/event.json'
import brownout from '../fixtures/brownout.json'
import library from '../fixtures/phone/library.json'
// Dev only (this file is imported only by the dev server and the fixture build): the test writer builds the log's bytes.
import { writeWpilog, type Fixture } from '../tests/helpers/fixture-format.ts'

const encoder = new TextEncoder()

/** A read-only store over a few text files held in memory. */
function textStore(files: Record<string, string>): ReadStore {
  const info = async (path: string): Promise<FileInfo> => {
    const bytes = encoder.encode(files[path])
    return { path, size: bytes.length, modifiedTime: Date.parse('2099-03-05T21:00:00Z'), sha256: await sha256Hex(bytes) }
  }
  return {
    list: async (prefix) => Promise.all(Object.keys(files).filter((p) => p.startsWith(`${prefix}/`)).sort().map(info)),
    stat: async (path) => (path in files ? info(path) : null),
    read: async (path, start, end) => encoder.encode(files[path]).slice(start, end),
  }
}

/** The one log the fixture's Drive holds: Q1's, built from fixtures/brownout.json. Its summary (test_q1.wpilog) carries these bytes' size. */
const Q1 = { name: 'test_q1.wpilog', path: 'logs/2098-2099/2099-03-05/test_q1.wpilog', bytes: writeWpilog((brownout as unknown as Fixture).entries) }

/** The invented event's start: 2099-03-05 17:00 UTC, moved to 09:00 today so Now shows an event day. */
const START = Date.UTC(2099, 2, 5, 17)
const shiftToToday = (): number => {
  const today = new Date()
  return new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9).getTime() - START
}

interface LibraryRow { day: number; minute: number; onField: boolean; matchType: number; matchNumber: number | null; event: boolean; wallSeconds: number; mb: number; runs?: number[] }

/**
 * The Library's manifest (what a laptop's manifests/ holds): fixtures/phone/library.json's rows, the shape of a real
 * three-day event (matches with off-the-field logs between them), its last day moved to today. The first Q1 row is the
 * one log the fixture can download (Q1's bytes, name and size, so its summary finds it); the rest have invented bytes.
 */
async function libraryManifest(shift: number): Promise<string> {
  const lastDay = Math.max(...(library.rows as LibraryRow[]).map((r) => r.day))
  let q1Taken = false
  const lines = await Promise.all((library.rows as LibraryRow[]).map(async (r, i) => {
    const at = START + shift + (r.day - lastDay) * 86_400_000 + (r.minute - 9 * 60) * 60_000
    const isQ1 = !q1Taken && r.matchType === 2 && r.matchNumber === 1 && (q1Taken = true)
    const name = isQ1 ? Q1.name : `test_${String(i + 1).padStart(2, '0')}.wpilog`
    const day = new Date(at).toISOString().slice(0, 10)
    const record = {
      type: 'log', kind: 'wpilog', sha256: isQ1 ? await sha256Hex(Q1.bytes) : (i + 100).toString(16).padStart(64, '0'), size: isQ1 ? Q1.bytes.length : r.mb * 2 ** 20,
      path: isQ1 ? Q1.path : `logs/2098-2099/${day}/${name}`, names: [name], modifiedTime: null, from: 'folder', recordedAt: at + r.wallSeconds * 1000, machine: 'laptop-a',
      playedAt: at, dateSource: 'robot', wall: { start: at, end: at + r.wallSeconds * 1000 }, matchWindow: r.onField ? { start: at, end: at + 150_000 } : null,
      event: r.event ? 'TEST' : '', matchType: r.matchType, matchNumber: r.matchNumber, onField: r.onField, batteryId: null, roboRio: null, edition: null, robot: null,
      ...(r.runs ? { runs: { count: r.runs.length, seconds: r.runs } } : {}),
    } as unknown as LogRecord
    return serializeRecord(record)
  }))
  return lines.join('')
}

/** The invented event moved to today, with Q1's summary naming the size of the log the fixture can download. */
function movedToToday(files: Record<string, string>, shift: number): Record<string, string> {
  const move = (line: string) => {
    const o = JSON.parse(line)
    if (o.summary?.fileName === Q1.name) o.summary.fileSize = Q1.bytes.length
    if (o.summary?.playedAt != null) o.summary.playedAt += shift
    if (typeof o.at === 'number') o.at += shift
    for (const k of ['when', 'played']) if (typeof o[k] === 'string') o[k] = new Date(Date.parse(o[k]) + shift).toISOString()
    return JSON.stringify(o)
  }
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t.split('\n').filter(Boolean).map(move).join('\n') + '\n']))
}

/** Whole-log downloads from memory, slowly enough that the progress line and Stop can be seen. */
const media = {
  async downloadWhole(path: string, opts: { onProgress?(got: number, total: number): void; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (path !== Q1.path) throw new Error(`${path} not found`)
    const total = Q1.bytes.length
    for (const part of [0.25, 0.6, 1]) {
      opts.signal?.throwIfAborted()
      await new Promise((r) => setTimeout(r, 400))
      opts.onProgress?.(Math.floor(total * part), total)
    }
    return Q1.bytes
  },
}

export async function installFixture(): Promise<void> {
  const shift = shiftToToday()
  const files = movedToToday((fixture as { files: Record<string, string> }).files, shift)
  installPhoneOver(textStore({ ...files, 'manifests/laptop-a.jsonl': await libraryManifest(shift) }), media)
}
