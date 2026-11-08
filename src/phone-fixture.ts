/**
 * The phone layout without a Drive: `?phone-fixture` in a dev build installs the phone's hub over the invented event in
 * fixtures/phone/event.json (scripts/phone-fixture.ts), so the phone pages can be seen and screenshotted. Dev only: main.ts
 * imports it only when `import.meta.env.DEV`.
 */
import type { FileInfo } from './hub/adapter.ts'
import { sha256Hex, type ReadStore } from './hub/phone-cache.ts'
import { installPhoneOver } from './phone.ts'
import fixture from '../fixtures/phone/event.json'

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

/** The invented event moved to today (it was played from 2099-03-05 17:00 UTC), so Now shows an event day. */
function movedToToday(files: Record<string, string>): Record<string, string> {
  const today = new Date()
  const shift = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9).getTime() - Date.UTC(2099, 2, 5, 17)
  const move = (line: string) => {
    const o = JSON.parse(line)
    if (o.summary?.playedAt != null) o.summary.playedAt += shift
    if (typeof o.at === 'number') o.at += shift
    for (const k of ['when', 'played']) if (typeof o[k] === 'string') o[k] = new Date(Date.parse(o[k]) + shift).toISOString()
    return JSON.stringify(o)
  }
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t.split('\n').filter(Boolean).map(move).join('\n') + '\n']))
}

export function installFixture(): void {
  installPhoneOver(textStore(movedToToday((fixture as { files: Record<string, string> }).files)))
}
