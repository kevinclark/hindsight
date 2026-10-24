// The triage history travels with the library: history/<machine id>.jsonl, appended by that machine only, folded from
// every machine's file, brought down and up by sync with the manifests' rules. Invented data only (event TEST).
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { syncWithTeam } from '../src/hub/sync.ts'
import { readText } from '../src/hub/adapter.ts'
import { boardState, boardStamp, migrationLines, parseHistory, type BoardEvent, type HistoryEvent } from '../src/triage/history.ts'

let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-hist-')) })
afterEach(() => rm(work, { recursive: true, force: true }))
const machine = (name: string) => LocalLibrary.open(join(work, name), name)

const issue = (key: string, status: string, when: string) => JSON.stringify({ type: 'issue', key, status, note: 'test reason', when })
const board = (device: string, seq: number, when: string, op: 'priority' | 'note', value: string): string => JSON.stringify({
  type: 'board', v: 1, key: 'mech/test · Arm', robot: 'TEST', op, value, by: { device, role: 'pit' }, seq, when,
} satisfies BoardEvent)
const fold = async (lib: LocalLibrary) => parseHistory(await lib.historyText()).events

describe('history in the library', () => {
  it('two machines append offline, sync, and both fold the same board', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    const b = await machine('mb')
    await a.appendHistory(`${board('ma', 1, '2026-10-24T10:00:00.000Z', 'priority', 'high')}\n${issue('mech/test · Arm', 'known', '2026-10-24T10:01:00.000Z')}\n`)
    await b.appendHistory(`${board('mb', 1, '2026-10-24T10:00:30.000Z', 'note', 'swapped the belt')}\n`)
    expect((await fold(a)).length).toBe(2) // offline: each sees only its own
    expect((await fold(b)).length).toBe(1)

    await syncWithTeam(a, team)
    const second = await syncWithTeam(b, team)
    await syncWithTeam(a, team)
    expect(second.history).toEqual([{ name: 'history/ma.jsonl', lines: 2 }])
    expect(second.problems).toEqual([])
    expect(await a.historyText()).toBe(await b.historyText())
    const events = await fold(b)
    expect(events.map((e) => e.when)).toEqual(['2026-10-24T10:00:00.000Z', '2026-10-24T10:00:30.000Z', '2026-10-24T10:01:00.000Z'])
    const state = [...boardState(events).values()][0]
    expect(state.priority).toBe('high')
    expect(state.notes.map((n) => n.text)).toEqual(['swapped the belt'])
    // each machine's own file holds only its own lines
    expect(await readText(a.store, 'history/ma.jsonl')).not.toContain('swapped the belt')
  })

  it("the team's longer copy of this machine's own file (a lost library) is pulled down, additively; the upload count is the lines that went up", async () => {
    const team = new MemoryAdapter()
    const l1 = issue('k1', 'known', '2026-10-24T10:00:00.000Z')
    const l2 = issue('k2', 'fixed', '2026-10-24T10:01:00.000Z')
    const a = await machine('ma')
    await a.appendHistory(`${l1}\n`)
    const up = await syncWithTeam(a, team)
    expect(up.historyPublished).toBe(1)
    team.files.set('history/ma.jsonl', { bytes: new TextEncoder().encode(`${l1}\n${l2}\n`), modifiedTime: 5 })
    const down = await syncWithTeam(a, team)
    expect(down.history).toEqual([{ name: 'history/ma.jsonl', lines: 1 }])
    expect(down.historyPublished).toBe(0)
    expect(down.problems).toEqual([])
    expect(await readText(a.store, 'history/ma.jsonl')).toBe(`${l1}\n${l2}\n`)
    // a fresh library with the same id gets everything
    const again = await LocalLibrary.open(join(work, 'ma2'), 'ma')
    await syncWithTeam(again, team)
    expect(await readText(again.store, 'history/ma.jsonl')).toBe(`${l1}\n${l2}\n`)
    await again.appendHistory(`${issue('k3', 'known', '2026-10-24T10:02:00.000Z')}\n`)
    const r = await syncWithTeam(again, team)
    expect(r.historyPublished).toBe(1)
  })

  it('a second sync with nothing new writes nothing', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await a.appendHistory(`${issue('k', 'known', '2026-10-24T10:00:00.000Z')}\n`)
    await syncWithTeam(a, team)
    team.writes.length = 0
    const again = await syncWithTeam(a, team)
    expect(team.writes).toEqual([])
    expect(again.history).toEqual([])
    expect(again.historyPublished).toBe(0)
  })

  it("a teammate's shorter or diverging history file is reported, not replaced", async () => {
    const a = await machine('ma')
    const team = new MemoryAdapter()
    const l1 = issue('k1', 'known', '2026-10-24T10:00:00.000Z')
    const l2 = issue('k2', 'fixed', '2026-10-24T10:01:00.000Z')
    team.put('history/mb.jsonl', `${l1}\n${l2}\n`)
    await syncWithTeam(a, team)
    expect(await readText(a.store, 'history/mb.jsonl')).toBe(`${l1}\n${l2}\n`)

    // shorter on the team store
    team.files.set('history/mb.jsonl', { bytes: new TextEncoder().encode(`${l1}\n`), modifiedTime: 1 })
    let r = await syncWithTeam(a, team)
    expect(r.problems.some((p) => p.startsWith('history/mb.jsonl'))).toBe(true)
    expect(await readText(a.store, 'history/mb.jsonl')).toBe(`${l1}\n${l2}\n`)

    // diverging
    const other = issue('k9', 'wrong', '2026-10-24T10:02:00.000Z')
    team.files.set('history/mb.jsonl', { bytes: new TextEncoder().encode(`${l1}\n${other}\n`), modifiedTime: 2 })
    r = await syncWithTeam(a, team)
    expect(r.problems.some((p) => p.startsWith('history/mb.jsonl'))).toBe(true)
    expect(await readText(a.store, 'history/mb.jsonl')).toBe(`${l1}\n${l2}\n`)
    expect(await readText(team, 'history/mb.jsonl')).toBe(`${l1}\n${other}\n`) // and the team's copy is untouched
  })

  it("this machine's file on the team store holding lines this copy lacks is reported, not overwritten", async () => {
    const a = await machine('ma')
    const team = new MemoryAdapter()
    team.put('history/ma.jsonl', `${issue('k1', 'known', '2026-10-24T10:00:00.000Z')}\n`)
    await a.appendHistory(`${issue('k2', 'known', '2026-10-24T10:05:00.000Z')}\n`)
    const r = await syncWithTeam(a, team)
    expect(r.problems.length).toBe(1)
    expect(await readText(team, 'history/ma.jsonl')).toBe(`${issue('k1', 'known', '2026-10-24T10:00:00.000Z')}\n`)
  })

  it('a line this build cannot type survives a round trip through sync, byte for byte', async () => {
    const team = new MemoryAdapter()
    const newer = '{"type":"board","v":2,"future":{"x":[1,2]},"when":"2026-10-24T10:00:00.000Z"}'
    const a = await machine('ma')
    const b = await machine('mb')
    await a.appendHistory(`${newer}\n`)
    await syncWithTeam(a, team)
    await syncWithTeam(b, team)
    expect(await readText(b.store, 'history/ma.jsonl')).toBe(`${newer}\n`)
    expect((await fold(b))[0]).toMatchObject({ type: 'opaque', raw: newer })
    expect(await b.historyText()).toBe(`${newer}\n`)
    // and b's own appends do not rewrite it
    await b.appendHistory(`${issue('k', 'known', '2026-10-24T11:00:00.000Z')}\n`)
    expect((await b.historyText()).split('\n')).toContain(newer)
  })

  it('appendHistory adds a line once, in any machine\'s file, and starts a fresh line after a crash', async () => {
    const a = await machine('ma')
    const line = issue('k', 'known', '2026-10-24T10:00:00.000Z')
    expect(await a.appendHistory(`${line}\n${line}\n`)).toBe(1)
    expect(await a.appendHistory(`${line}\n`)).toBe(0)
    await mkdir(join(work, 'ma', 'history'), { recursive: true })
    await writeFile(join(work, 'ma', 'history', 'ma.jsonl'), `${line}\n{"type":"issue"`) // torn last line
    const next = issue('k2', 'known', '2026-10-24T10:01:00.000Z')
    await a.appendHistory(`${next}\n`)
    expect(await readFile(join(work, 'ma', 'history', 'ma.jsonl'), 'utf8')).toBe(`${line}\n{"type":"issue"\n${next}\n`)
  })
})

describe('first open: the browser store moves into the library once', () => {
  it('appends what the library lacks, by exact text, and never twice', async () => {
    const a = await machine('ma')
    const l1 = issue('k1', 'known', '2026-10-24T10:00:00.000Z')
    const l2 = issue('k2', 'fixed', '2026-10-24T10:01:00.000Z')
    const stored = `${l1}\n${l2}\n`
    await a.appendHistory(`${l1}\n`) // one already there (a teammate's file or an earlier run)

    const first = migrationLines(await a.historyText(), stored)
    expect(first).toEqual({ text: `${l2}\n`, count: 1 })
    await a.appendHistory(first!.text)
    expect(migrationLines(await a.historyText(), stored)).toBeNull() // the next open finds nothing to move
    expect(await a.appendHistory(stored)).toBe(0) // and even a forced second append writes nothing
    expect(((await readText(a.store, 'history/ma.jsonl')) ?? '').split('\n').filter(Boolean)).toEqual([l1, l2])
  })
})

describe('a failed append', () => {
  it('lines kept in the browser store are moved by the next open', async () => {
    const a = await machine('ma')
    const lost = issue('k', 'known', '2026-10-24T10:00:00.000Z')
    expect(migrationLines(await a.historyText(), `${lost}\n`)).toEqual({ text: `${lost}\n`, count: 1 })
  })
})

describe('boardStamp', () => {
  const ev = (device: string, seq: number, when: string): HistoryEvent => parseHistory(board(device, seq, when, 'note', 'x')).events[0]
  it('seq is 1 + this device\'s largest in the merged history; when never goes behind the newest line', () => {
    const history = [ev('ma', 3, '2026-10-24T10:00:00.000Z'), ev('mb', 9, '2026-10-24T12:00:00.000Z'), ev('ma', 2, '2026-10-24T09:00:00.000Z')]
    expect(boardStamp(history, 'ma', new Date('2026-10-24T10:30:00.000Z'))).toEqual({ seq: 4, when: '2026-10-24T12:00:00.000Z' })
    expect(boardStamp(history, 'mc', new Date('2026-10-24T13:00:00.000Z'))).toEqual({ seq: 1, when: '2026-10-24T13:00:00.000Z' })
    expect(boardStamp([], 'ma', new Date('2026-10-24T13:00:00.000Z'))).toEqual({ seq: 1, when: '2026-10-24T13:00:00.000Z' })
  })
})
