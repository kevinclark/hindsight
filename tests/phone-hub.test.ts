import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { SignInAgain, type FileInfo } from '../src/hub/adapter.ts'
import { DriveReader, isReadOnlyRequest } from '../src/hub/drive-read.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { memoryCache, readAppendOnly, sha256Hex, type ReadStore } from '../src/hub/phone-cache.ts'
import { BrowserHub } from '../src/hub/browser-hub.ts'
import { serializeEventLine, type EventLine } from '../src/hub/event-file.ts'
import { mergeHistory, parseHistory, serializeHistory } from '../src/triage/history.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const enc = (s: string) => new TextEncoder().encode(s)

function summary(fileName: string, playedAt: number | null): MatchSummary {
  return { fileName, playedAt, rules: {}, metrics: {}, robot: { profileId: 'test' } } as unknown as MatchSummary
}
function line(sha: string, analyzer: string, at: number, fileName = `${sha}.wpilog`, playedAt: number | null = at): string {
  const l: EventLine = { sha256: sha.padEnd(64, '0'), analyzer, shape: 1, at, summary: summary(fileName, playedAt) }
  return serializeEventLine(l)
}
const issue = (key: string, when: string) => `${JSON.stringify({ type: 'issue', key, status: 'known', note: 'test reason', when })}\n`

/** A store that counts: the lists asked for and the ranges read. */
function spy(inner: MemoryAdapter, opts: { noSha?: boolean } = {}) {
  const lists: string[] = []
  const reads: { path: string; start: number; end: number }[] = []
  const strip = (i: FileInfo): FileInfo => { if (opts.noSha) { const { sha256: _s, md5: _m, ...rest } = i; return rest } return i }
  const store: ReadStore = {
    list: async (prefix) => { lists.push(prefix); return (await inner.list(prefix)).map(strip) },
    stat: async (path) => { const i = await inner.stat(path); return i ? strip(i) : null },
    read: async (path, start, end) => { reads.push({ path, start, end }); return inner.read(path, start, end) },
  }
  return { store, lists, reads }
}
const hub = (store: ReadStore, cache = memoryCache()) => new BrowserHub({ store, cache, version: '0.0.0-test' })

describe('BrowserHub.event', () => {
  it('folds two laptops to one line per log and reads only that event\'s files, never manifests', async () => {
    const m = new MemoryAdapter()
    m.put('events/2026test--laptop-a.jsonl', line('aa', '0.1.5+aaaa', 100) + line('bb', '0.1.5+aaaa', 100) + line('dd', '0.1.5+aaaa', 50))
    m.put('events/2026test--laptop-b.jsonl', line('aa', '0.1.6+bbbb', 90) + line('bb', '0.1.5+aaaa', 200) + line('cc', '0.1.5+aaaa', 10))
    m.put('events/2026other--laptop-a.jsonl', line('ee', '0.1.5+aaaa', 1))
    m.put('manifests/laptop-a.jsonl', 'x'.repeat(1000))
    const s = spy(m)
    const got = await hub(s.store).event('2026test')
    expect(got.logs.map((l) => l.line.sha256.slice(0, 2))).toEqual(['cc', 'dd', 'aa', 'bb'])
    expect(got.logs.find((l) => l.line.sha256.startsWith('aa'))!.line.analyzer).toBe('0.1.6+bbbb') // newer version wins
    expect(got.logs.find((l) => l.line.sha256.startsWith('bb'))!.line.at).toBe(200) // same version: later at
    expect(got.laptops.map((l) => l.machine)).toEqual(['laptop-a', 'laptop-b'])
    expect(s.reads.every((r) => r.path.startsWith('events/2026test--'))).toBe(true)
    expect(s.lists.some((p) => p.startsWith('manifests'))).toBe(false)
  })

  it('puts logs with no played-at time last, and refuses a bad key', async () => {
    const m = new MemoryAdapter()
    m.put('events/2026test--laptop-a.jsonl', line('aa', 'v1', 1, 'a.wpilog', null) + line('bb', 'v1', 1, 'b.wpilog', 5))
    const h = hub(spy(m).store)
    expect((await h.event('2026test')).logs.map((l) => l.line.summary.fileName)).toEqual(['b.wpilog', 'a.wpilog'])
    await expect(h.event('../x')).rejects.toThrow()
    expect(h.readOnly).toBe(true)
    expect(await h.info()).toEqual({ version: '0.0.0-test', readOnly: true })
  })
})

describe('BrowserHub.history', () => {
  it('merges every laptop\'s history into what a laptop\'s hub.history() would give', async () => {
    const m = new MemoryAdapter()
    const a = issue('k1', '2026-01-01T00:00:00Z') + issue('k2', '2026-01-03T00:00:00Z')
    const b = issue('k3', '2026-01-02T00:00:00Z') + issue('k1', '2026-01-01T00:00:00Z')
    m.put('history/laptop-a.jsonl', a)
    m.put('history/laptop-b.jsonl', b)
    m.put('manifests/laptop-a.jsonl', 'big')
    const s = spy(m)
    const want = serializeHistory(mergeHistory(parseHistory(a).events, parseHistory(b).events))
    expect(await hub(s.store).history()).toBe(want)
    expect(s.lists.some((p) => p.startsWith('manifests'))).toBe(false)
  })
})

describe('readAppendOnly cache', () => {
  const key = 'events/2026test--laptop-a.jsonl'
  it('reads nothing when nothing changed', async () => {
    const m = new MemoryAdapter()
    m.put(key, line('aa', 'v1', 1))
    const s = spy(m)
    const h = hub(s.store)
    await h.event('2026test')
    const before = s.reads.length
    await h.event('2026test')
    expect(s.reads.length).toBe(before)
  })

  it('reads only the new tail after an append, and the result equals the whole file', async () => {
    const m = new MemoryAdapter()
    const first = line('aa', 'v1', 1)
    m.put(key, first)
    const s = spy(m)
    const h = hub(s.store)
    await h.event('2026test')
    m.put(key, first + line('bb', 'v1', 2) + 'é\n')
    s.reads.length = 0
    const got = await h.event('2026test')
    expect(s.reads).toEqual([{ path: key, start: enc(first).length, end: enc(first).length + enc(line('bb', 'v1', 2) + 'é\n').length }])
    expect(got.logs.length).toBe(2)
    const info = (await m.stat(key))!
    const r = await readAppendOnly(s.store, info, memoryCache())
    expect(r.how).toBe('whole')
  })

  it('does not split a multibyte character at the tail boundary', async () => {
    const m = new MemoryAdapter()
    const cache = memoryCache()
    const s = spy(m)
    m.put('history/laptop-a.jsonl', 'ab')
    await readAppendOnly(s.store, (await m.stat('history/laptop-a.jsonl'))!, cache)
    m.put('history/laptop-a.jsonl', 'abé€')
    const r = await readAppendOnly(s.store, (await m.stat('history/laptop-a.jsonl'))!, cache)
    expect(r).toEqual({ text: 'abé€', how: 'tail' })
  })

  it('reads whole a file that was rewritten, same length or longer', async () => {
    const m = new MemoryAdapter()
    const cache = memoryCache()
    const s = spy(m)
    m.put(key, 'aaaa\n')
    await readAppendOnly(s.store, (await m.stat(key))!, cache)
    m.put(key, 'bbbb\n')
    expect((await readAppendOnly(s.store, (await m.stat(key))!, cache)).how).toBe('whole')
    m.put(key, 'cccc\ncc\n')
    s.reads.length = 0
    const r = await readAppendOnly(s.store, (await m.stat(key))!, cache)
    expect(r).toEqual({ text: 'cccc\ncc\n', how: 'whole' })
    expect(s.reads.map((x) => x.start)).toEqual([5, 0]) // the tail failed its checksum, then the whole file
    expect((await cache.get(key))!.sha256).toBe(await sha256Hex(enc('cccc\ncc\n')))
  })

  it('reads whole every time when the store gives no sha-256', async () => {
    const m = new MemoryAdapter()
    m.put(key, line('aa', 'v1', 1))
    const s = spy(m, { noSha: true })
    const h = hub(s.store)
    await h.event('2026test')
    await h.event('2026test')
    expect(s.reads.map((r) => r.start)).toEqual([0, 0])
    m.put(key, line('aa', 'v1', 1) + line('bb', 'v1', 1))
    s.reads.length = 0
    await h.event('2026test')
    expect(s.reads.map((r) => r.start)).toEqual([0])
  })
})

describe('BrowserHub.check, freshness and watch', () => {
  it('says true and tells listeners after an append, false and silent when unchanged', async () => {
    const m = new MemoryAdapter()
    m.put('events/2026test--laptop-a.jsonl', line('aa', 'v1', 1))
    m.put('history/laptop-a.jsonl', issue('k1', '2026-01-01T00:00:00Z'))
    const s = spy(m)
    let now = 1000
    const h = new BrowserHub({ store: s.store, cache: memoryCache(), version: 't', now: () => now })
    expect(h.freshness()).toEqual({ readAt: null, newestFile: null })
    await h.event('2026test'); await h.history()
    let fired = 0
    const off = h.onChange(() => { fired++ })
    expect(await h.check('2026test')).toBe(false)
    expect(fired).toBe(0)
    m.put('history/laptop-a.jsonl', issue('k1', '2026-01-01T00:00:00Z') + issue('k2', '2026-01-02T00:00:00Z'))
    now = 2000
    expect(await h.check('2026test')).toBe(true)
    expect(fired).toBe(1)
    expect(h.freshness().readAt).toBe(2000)
    expect(h.freshness().newestFile).toBe((await m.stat('history/laptop-a.jsonl'))!.modifiedTime)
    off()
    await h.history()
    m.put('history/laptop-a.jsonl', issue('k9', '2026-02-02T00:00:00Z'))
    await h.check('2026test')
    expect(fired).toBe(1)
    expect(s.lists.every((p) => p === 'events' || p === 'history')).toBe(true)
  })

  it('watch polls, swallows a failed check and stops', async () => {
    const m = new MemoryAdapter()
    m.put('events/2026test--laptop-a.jsonl', line('aa', 'v1', 1))
    let fail = false
    const s = spy(m)
    const store: ReadStore = { ...s.store, list: async (p) => { if (fail) throw new Error('offline'); return s.store.list(p) } }
    const h = hub(store)
    let fired = 0
    h.onChange(() => { fired++ })
    const stop = h.watch('2026test', { everyMs: 5 })
    await new Promise((r) => setTimeout(r, 30))
    expect(fired).toBeGreaterThan(0)
    const readAt = h.freshness().readAt
    fail = true
    await new Promise((r) => setTimeout(r, 30))
    expect(h.freshness().readAt).toBe(readAt)
    stop()
    const n = s.lists.length
    fail = false
    await new Promise((r) => setTimeout(r, 30))
    expect(s.lists.length).toBe(n)
  })
})

describe('DriveReader', () => {
  it('refuses everything but a GET of the files and drives endpoints', () => {
    const f = 'https://www.googleapis.com/drive/v3/files'
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isReadOnlyRequest(m, `${f}/abc`)).toBe(false)
    expect(isReadOnlyRequest('GET', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')).toBe(false)
    expect(isReadOnlyRequest('GET', `${f}/abc/copy`)).toBe(false)
    expect(isReadOnlyRequest('GET', `${f}?q=x`)).toBe(true)
    expect(isReadOnlyRequest('GET', `${f}/abc?alt=media`)).toBe(true)
  })

  it('sends only GETs through list, stat and read, and cannot create a folder', async () => {
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'events')
    drive.addFile(folder, '2026test--laptop-a.jsonl', 'hello\n')
    const methods: string[] = []
    const fetchSpy: typeof fetch = (url, init) => { methods.push((init?.method ?? 'GET').toUpperCase()); return drive.fetch(url, init) }
    const r = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: fetchSpy, sleep: async () => {} })
    expect((await r.list('events')).length).toBe(1)
    expect((await r.stat('events/2026test--laptop-a.jsonl'))!.size).toBe(6)
    expect(new TextDecoder().decode(await r.read('events/2026test--laptop-a.jsonl', 1, 4))).toBe('ell')
    expect(await r.list('nothing')).toEqual([])
    expect(methods.length).toBeGreaterThan(3)
    expect(new Set(methods)).toEqual(new Set(['GET']))
    await expect((r as unknown as { request(u: string, i: RequestInit): Promise<Response> }).request('https://www.googleapis.com/drive/v3/files/x', { method: 'DELETE' })).rejects.toThrow(/never sends DELETE/)
    expect(methods.length).toBe(methods.filter((m) => m === 'GET').length)
  })

  it('refreshes the token once on a 401, then throws SignInAgain', async () => {
    const drive = new FakeDrive()
    const asked: (boolean | undefined)[] = []
    const r = new DriveReader({ rootId: 'root', token: async (refresh) => { asked.push(refresh); return 'bad' }, fetch: drive.fetch, sleep: async () => {} })
    await expect(r.stat('events/x.jsonl')).rejects.toBeInstanceOf(SignInAgain)
    expect(asked).toEqual([false, true])
  })

  it('is what DriveAdapter is built on', () => {
    expect(Object.getPrototypeOf(DriveAdapter.prototype)).toBe(DriveReader.prototype)
  })
})

describe('phone files stay free of node: modules', () => {
  it('reaches no node: import from the phone entry files', () => {
    const seen = new Set<string>()
    const bad: string[] = []
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = readFileSync(file, 'utf8')
      if (/from\s+['"]node:|import\s*\(\s*['"]node:|import\s+['"]node:/.test(text)) bad.push(file)
      // `import type` is erased at build time, so what it names never reaches the phone.
      for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]|(?:import\s*\(\s*)['"](\.[^'"]+)['"]/gm)) visit(join(dirname(file), m[1] ?? m[2]))
    }
    for (const f of ['drive-read', 'phone-cache', 'browser-hub', 'event-file']) visit(`src/hub/${f}.ts`)
    expect(bad).toEqual([])
    expect(seen.size).toBeGreaterThan(5)
  })
})
