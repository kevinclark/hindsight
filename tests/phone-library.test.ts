// The phone's Library: every team log the laptops' manifests list, newest first; opening one downloads it whole (with the
// DS logs that belong to it) through the reader it is given for log bytes, checks each file's sha-256, and keeps nothing.
// Invented data only.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { BrowserHub } from '../src/hub/browser-hub.ts'
import { DriveReader } from '../src/hub/drive-read.ts'
import { memoryCache } from '../src/hub/phone-cache.ts'
import { serializeRecord, type LogRecord } from '../src/hub/types.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)
const T = Date.UTC(2099, 2, 5, 17)

function rec(kind: 'wpilog' | 'dslog', name: string, content: Uint8Array, at: number, machine: string): LogRecord {
  return {
    type: 'log', kind, sha256: sha(content), size: content.length, path: `logs/2098-2099/2099-03-05/${name}`, names: [name], modifiedTime: null,
    from: 'folder', recordedAt: at, machine, playedAt: at, dateSource: 'robot', wall: { start: at, end: at + 150_000 }, matchWindow: kind === 'wpilog' ? { start: at, end: at + 150_000 } : null,
    event: 'TEST', matchType: 2, matchNumber: at === T ? 1 : 2, onField: true, batteryId: null, roboRio: null, edition: null, robot: null,
  } as unknown as LogRecord
}

function team() {
  const drive = new FakeDrive()
  drive.pageSize = 100
  const logs = drive.addFolder('root', 'logs')
  const year = drive.addFolder(logs, '2098-2099')
  const day = drive.addFolder(year, '2099-03-05')
  const q1 = bytes(70_000, 1), q2 = bytes(90_000, 2), ds = bytes(5_000, 3)
  drive.addFile(day, 'q1.wpilog', q1)
  drive.addFile(day, 'q2.wpilog', q2)
  drive.addFile(day, 'q2.dslog', ds)
  const manifests = drive.addFolder('root', 'manifests')
  drive.addFile(manifests, 'laptop-a.jsonl', serializeRecord(rec('wpilog', 'q1.wpilog', q1, T, 'laptop-a')))
  drive.addFile(manifests, 'laptop-b.jsonl', serializeRecord(rec('wpilog', 'q2.wpilog', q2, T + 600_000, 'laptop-b')) + serializeRecord(rec('dslog', 'q2.dslog', ds, T + 600_000, 'laptop-b')))
  drive.addFile(manifests, 'notes.txt', 'not a manifest')
  return { drive, q1, q2, ds, day }
}

function hubOver(drive: FakeDrive) {
  const requests: string[] = []
  const via = (who: string): typeof fetch => (url, init) => { requests.push(`${who} ${new Headers(init?.headers as Record<string, string>).get('range') ? 'range ' : ''}${String(url).split('?')[0].split('/').slice(-2).join('/')}`); return drive.fetch(url, init) }
  const store = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: via('store'), sleep: async () => {} })
  const media = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: via('media'), sleep: async () => {} })
  return { hub: new BrowserHub({ store, cache: memoryCache(), version: '0.0.0-test', media }), requests }
}

describe('phone Library', () => {
  it('lists every robot log the manifests name, newest first, with the DS logs that belong to it', async () => {
    const { hub } = hubOver(team().drive)
    const logs = await hub.logs()
    expect(logs.map((e) => e.record.names[0])).toEqual(['q2.wpilog', 'q1.wpilog'])
    expect(logs[0].attached.dslog.map((r) => r.names[0])).toEqual(['q2.dslog'])
  })

  it('opens a log whole through the media reader (watched ranged reads), the bytes checked, progress to the total', async () => {
    const { drive, q2, ds } = team()
    const { hub, requests } = hubOver(drive)
    const [entry] = await hub.logs()
    requests.length = 0
    const seen: [number, number][] = []
    const files = await hub.openLog(entry, { onProgress: (got, total) => seen.push([got, total]) })
    expect(files.map((f) => f.name)).toEqual(['q2.wpilog', 'q2.dslog'])
    expect(files[0].bytes).toEqual(q2)
    expect(files[1].bytes).toEqual(ds)
    expect(seen.at(-1)).toEqual([q2.length + ds.length, q2.length + ds.length])
    expect(requests.filter((r) => r.startsWith('media')).length).toBeGreaterThan(0)
    expect(requests.filter((r) => r.startsWith('store'))).toEqual([]) // nothing of an opened log goes through the native path
  })

  it('refuses a file whose bytes are not the ones the manifest names', async () => {
    const { drive, day } = team()
    const { hub } = hubOver(drive)
    const [entry] = await hub.logs()
    const node = [...drive.nodes.values()].find((n) => n.parents[0] === day && n.name === 'q2.wpilog')!
    node.bytes = bytes(90_000, 9)
    await expect(hub.openLog(entry)).rejects.toThrow(/not the log the team's list names/)
  })

  it('stops when asked, without retrying the download', async () => {
    const { drive } = team()
    const { hub, requests } = hubOver(drive)
    const [entry] = await hub.logs()
    const stop = new AbortController()
    stop.abort()
    requests.length = 0
    await expect(hub.openLog(entry, { signal: stop.signal })).rejects.toThrow()
    expect(requests.filter((r) => r.startsWith('media') && /\.wpilog|\.dslog|files\/[^/]+$/.test(r)).length).toBeLessThanOrEqual(3)
  })

  it('without a media reader the hub cannot open logs (an event-only phone)', async () => {
    const drive = team().drive
    const store = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const hub = new BrowserHub({ store, cache: memoryCache(), version: '0.0.0-test' })
    const [entry] = await hub.logs()
    await expect(hub.openLog(entry)).rejects.toThrow(/cannot open logs/)
  })
})

describe('installPhone', () => {
  it('downloads log bytes through mediaFetch and nothing else through it; the rest goes through fetch', async () => {
    const { installPhone } = await import('../src/phone.ts')
    const { drive } = team()
    const went: string[] = []
    // Which file a media read is for, by its Drive id: the manifests go through fetch (native), the log and its DS log through mediaFetch.
    const nameOf = (url: string) => drive.nodes.get(/files\/([^/?]+)\?alt=media/.exec(url)?.[1] ?? '')?.name
    const kind = (url: string) => !url.includes('alt=media') ? 'api' : /\.jsonl$/.test(nameOf(url) ?? '') ? 'manifest' : 'log'
    const spy = (who: string): typeof fetch => (url, init) => { went.push(`${who} ${kind(String(url))}`); return drive.fetch(url, init) }
    const hub = installPhone({ rootId: 'root', token: async () => 'good', fetch: spy('native'), mediaFetch: spy('web') })
    const [entry] = await hub.logs()
    await hub.openLog(entry)
    expect(went.filter((w) => w === 'native log')).toEqual([])
    expect(went.filter((w) => w === 'web log').length).toBe(2)
    expect(went.filter((w) => w === 'web manifest')).toEqual([])
    expect(went.filter((w) => w === 'web api').length).toBeGreaterThan(0) // finding the file by path
  })
})

describe('DriveReader.downloadWhole', () => {
  // A Drive whose media answers come in chunks, so a stop can land mid-download; `say` overrides the size Drive reports.
  function chunked(content: Uint8Array, opts: { say?: number; status?: number[] } = {}) {
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'logs')
    drive.addFile(folder, 'a.wpilog', content)
    let gets = 0
    const statuses = [...(opts.status ?? [])]
    const f: typeof fetch = async (url, init) => {
      const u = String(url)
      if (!u.includes('alt=media')) {
        const res = await drive.fetch(url, init)
        if (opts.say === undefined) return res
        const body = await res.json() as { files?: { size?: string }[]; size?: string }
        for (const file of body.files ?? [body]) if (file.size) file.size = String(opts.say)
        return new Response(JSON.stringify(body), { status: res.status })
      }
      gets++
      const s = statuses.shift()
      if (s) return new Response('busy', { status: s })
      let i = 0
      // Slow enough (20 ms a chunk) for the reader's Stop check to land mid-body.
      return new Response(new ReadableStream<Uint8Array>({ async pull(c) { await new Promise((r) => setTimeout(r, 20)); if (i >= content.length) c.close(); else { c.enqueue(content.slice(i, i + 1000)); i += 1000 } } }))
    }
    let slept = 0
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async (ms) => { slept += ms } })
    return { reader, gets: () => gets, slept: () => slept }
  }

  it('stops mid-download when asked, and sends no second request', async () => {
    const { reader, gets } = chunked(bytes(10_000, 4))
    const stop = new AbortController()
    const got = reader.downloadWhole('logs/a.wpilog', { signal: stop.signal, onProgress: (n) => { if (n >= 3000) stop.abort() } })
    await expect(got).rejects.toThrow(/stopped/i)
    expect(gets()).toBe(1)
  })

  it('stops during a retry wait instead of sleeping it out', async () => {
    const { reader, gets } = chunked(bytes(1000, 5), { status: [503, 503, 503] })
    const stop = new AbortController()
    const was = (reader as unknown as { sleep: (ms: number) => Promise<void> }).sleep
    ;(reader as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => { stop.abort(); return was(ms) }
    await expect(reader.downloadWhole('logs/a.wpilog', { signal: stop.signal })).rejects.toThrow(/stopped/i)
    expect(gets()).toBe(1)
  })

  // Longer than Drive said is cut to the size asked for; openLog's sha-256 check refuses it (tested above).
  it('refuses a body shorter than the size Drive gave (after asking for the rest)', async () => {
    const short = chunked(bytes(5000, 6), { say: 6000 })
    await expect(short.reader.downloadWhole('logs/a.wpilog')).rejects.toThrow()
    expect(short.gets()).toBeGreaterThan(1)
  })
})

describe('Library list helpers', () => {
  it('labels a log by its match, else on or off the field', async () => {
    const { logLabel } = await import('../src/ui/phone-library.ts')
    const r = (matchType: number | null, matchNumber: number | null, onField = true) => ({ matchType, matchNumber, onField }) as LogRecord
    expect([r(2, 13), r(3, 2), r(1, 4), r(null, null), r(0, null, false)].map(logLabel)).toEqual(['Q13', 'Playoff 2', 'Practice 4', 'On the field', 'Off the field'])
  })

  it('filters by event (all, one, none) and groups by day, newest first as given, undated last', async () => {
    const { byDay, filterByEvent, NO_EVENT } = await import('../src/ui/phone-library.ts')
    const e = (event: string, playedAt: number | null) => ({ record: { event, playedAt } }) as unknown as import('../src/hub/catalog.ts').Entry
    const list = [e('TEST', Date.UTC(2099, 2, 6, 18)), e('TEST', Date.UTC(2099, 2, 6, 17)), e('', Date.UTC(2099, 2, 5, 18)), e('OTHER', null)]
    expect(filterByEvent(list, '').length).toBe(4)
    expect(filterByEvent(list, 'TEST').length).toBe(2)
    expect(filterByEvent(list, NO_EVENT).map((x) => x.record.event)).toEqual([''])
    expect(byDay(list).map((d) => [d.day, d.logs.length])).toEqual([['2099-03-06', 2], ['2099-03-05', 1], ['No date', 1]])
  })

  it('marks a log over 275 MB as large (the size measured on one recent iPhone)', async () => {
    const { isLarge } = await import('../src/ui/phone-library.ts')
    expect([isLarge(275 * 2 ** 20), isLarge(275 * 2 ** 20 + 1)]).toEqual([false, true])
  })
})

describe('downloadWhole in slices', () => {
  it('reads a file larger than one slice in ranged slices into one buffer, progress rising to the total', async () => {
    const { PIECE_READ } = await import('../src/hub/drive-read.ts')
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'logs')
    const content = bytes(PIECE_READ * 2 + 12345, 7)
    drive.addFile(folder, 'big.wpilog', content)
    const ranges: string[] = []
    const f: typeof fetch = (url, init) => { const r = new Headers(init?.headers as Record<string, string>).get('range'); if (r) ranges.push(r); return drive.fetch(url, init) }
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    const seen: number[] = []
    const got = await reader.downloadWhole('logs/big.wpilog', { onProgress: (n) => seen.push(n) })
    expect(got.length).toBe(content.length)
    expect(sha(got)).toBe(sha(content))
    expect(ranges).toEqual([`bytes=0-${PIECE_READ - 1}`, `bytes=${PIECE_READ}-${2 * PIECE_READ - 1}`, `bytes=${2 * PIECE_READ}-${content.length - 1}`])
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1])).toBe(true)
    expect(seen.at(-1)).toBe(content.length)
  })
})

describe('On this phone', () => {
  it('keeps only logs whose file and DS logs are all kept', async () => {
    const { onThisPhone } = await import('../src/ui/phone-library.ts')
    const e = (sha: string, ds: string[] = []) => ({ record: { sha256: sha }, attached: { dslog: ds.map((s) => ({ sha256: s })), dsevents: [], hoot: [] } }) as unknown as import('../src/hub/catalog.ts').Entry
    const list = [e('a'), e('b', ['bd']), e('c', ['cd'])]
    expect(onThisPhone(list, new Set(['a', 'b', 'bd', 'c'])).map((x) => x.record.sha256)).toEqual(['a', 'b'])
  })
})
