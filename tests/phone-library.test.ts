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

  it('opens a log whole: one plain GET per file through the media reader, the bytes checked, progress to the total', async () => {
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
    const reads = requests.filter((r) => r.startsWith('media') && !r.includes('files/files'))
    expect(requests.filter((r) => r.startsWith('store') && /wpilog|dslog/.test(r))).toEqual([])
    expect(reads.every((r) => !r.includes('range'))).toBe(true)
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
    // A whole-file download is alt=media with no Range; the manifests are small ranged reads, through the native path by design.
    const kind = (url: string, init?: RequestInit) => !url.includes('alt=media') ? 'api' : new Headers(init?.headers as Record<string, string>).has('range') ? 'ranged' : 'whole'
    const spy = (who: string): typeof fetch => (url, init) => { went.push(`${who} ${kind(String(url), init)}`); return drive.fetch(url, init) }
    const hub = installPhone({ rootId: 'root', token: async () => 'good', fetch: spy('native'), mediaFetch: spy('web') })
    const [entry] = await hub.logs()
    await hub.openLog(entry)
    expect(went.filter((w) => w === 'native whole')).toEqual([])
    expect(went.filter((w) => w === 'web whole').length).toBe(2)
    expect(went.filter((w) => w === 'web ranged')).toEqual([])
    expect(went.filter((w) => w === 'web api').length).toBeGreaterThan(0) // finding the file by path
  })
})
