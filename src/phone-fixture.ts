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

/** The Library's manifest line for Q1 (what a laptop's manifests/ holds), played when its summary says. */
async function q1Manifest(shift: number): Promise<string> {
  const at = START + shift
  const record = {
    type: 'log', kind: 'wpilog', sha256: await sha256Hex(Q1.bytes), size: Q1.bytes.length, path: Q1.path, names: [Q1.name], modifiedTime: null,
    from: 'folder', recordedAt: at + 150_000, machine: 'laptop-a', playedAt: at, dateSource: 'robot', wall: { start: at, end: at + 150_000 },
    matchWindow: { start: at, end: at + 150_000 }, event: 'TEST', matchType: 2, matchNumber: 1, onField: true, batteryId: null, roboRio: null, edition: null, robot: null,
  } as unknown as LogRecord
  return serializeRecord(record)
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
  installPhoneOver(textStore({ ...files, 'manifests/laptop-a.jsonl': await q1Manifest(shift) }), media)
}
