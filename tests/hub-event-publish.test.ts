// Laptops publish each event's match summaries for the phone: one append-only file per laptop, events/<key>--<machine>.jsonl,
// a line per log per analyzer id, built from the Session view's own grouping (so pit runs count by day), with no marks
// inside. Invented data only (event TEST, key 2099test).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { isOwnAppendPath, readText } from '../src/hub/adapter.ts'
import { analyzerId, eventFilePath, foldEvent, parseEventLines, parseEventPath, type EventLine } from '../src/hub/event-file.ts'
import { eventLines, eventLogNames, latestEventSession } from '../src/hub/event-publish.ts'
import { groupSessions } from '../src/session/session.ts'
import { match, BASE } from './helpers/board-scene.ts'

let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-events-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

const KEY = '2099test'
const sha = (n: number) => n.toString(16).padStart(64, '0')
const line = (n: number, analyzer: string, at = 1): EventLine => ({ sha256: sha(n), analyzer, shape: 4, at, summary: { ...match(n), metrics: {} } as never })
const text = (...lines: EventLine[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('')

describe('event files', () => {
  it('are files one machine appends to, flat in events/, named by the event key and the machine', () => {
    expect(eventFilePath(KEY, 'laptop-a')).toBe('events/2099test--laptop-a.jsonl')
    expect(isOwnAppendPath('events/2099test--laptop-a.jsonl')).toBe(true)
    expect(parseEventPath('events/2099test--laptop-a.jsonl')).toEqual({ key: KEY, machine: 'laptop-a' })
    // a folder per event, a name with no machine, or anything else under events/ is not one
    for (const p of ['events/2099test/laptop-a.jsonl', 'events/2099test.jsonl', 'events/TEST--laptop-a.jsonl', 'events/2099test--a.json']) expect(isOwnAppendPath(p)).toBe(false)
    expect(() => eventFilePath('2099-test', 'laptop-a')).toThrow()
  })

  it('every adapter appends to them under the manifest rule (the memory adapter, as the reference)', async () => {
    const team = new MemoryAdapter()
    const path = eventFilePath(KEY, 'laptop-a')
    await team.appendManifest(path, text(line(1, '0.1.5+aaaa')))
    await team.appendManifest(path, text(line(1, '0.1.5+aaaa'), line(2, '0.1.5+aaaa')))
    await expect(team.appendManifest(path, text(line(3, '0.1.5+aaaa')))).rejects.toThrow(/holds records this copy lacks/)
  })

  it('a laptop writes one line per log per analyzer id, appended, never rewritten', async () => {
    const lib = await LocalLibrary.open(join(work, 'a'), 'laptop-a')
    expect(await lib.appendEvent(KEY, text(line(1, '0.1.5+aaaa'), line(2, '0.1.5+aaaa')))).toBe(2)
    const first = (await readText(lib.store, lib.ownEventPath(KEY)))!
    // the same lines again: nothing; a line for a log already there with the same analyzer but another `at`: nothing
    expect(await lib.appendEvent(KEY, text(line(1, '0.1.5+aaaa', 99)))).toBe(0)
    // a rules change mid-event: a second line for the same log
    expect(await lib.appendEvent(KEY, text(line(1, '0.1.6+bbbb')))).toBe(1)
    const after = (await readText(lib.store, lib.ownEventPath(KEY)))!
    expect(after.startsWith(first)).toBe(true)
    expect(parseEventLines(after).lines.map((l) => [l.sha256.slice(-1), l.analyzer])).toEqual([['1', '0.1.5+aaaa'], ['2', '0.1.5+aaaa'], ['1', '0.1.6+bbbb']])
    // lines of the wrong shape are not written
    expect(await lib.appendEvent(KEY, '{"sha256":"nope"}\n')).toBe(0)
    await expect(lib.appendEvent('not a key', text(line(4, '0.1.5+aaaa')))).rejects.toThrow()
  })

  it('the phone keeps, per log, the newest version; the later line on a tie; and says which laptop it came from', () => {
    const { logs } = foldEvent([
      { machine: 'laptop-b', text: text(line(1, '0.1.7+cccc', 5), line(2, '0.1.5+aaaa', 9)) },
      { machine: 'laptop-a', text: text(line(1, '0.1.6+bbbb', 50), line(2, '0.1.5+dddd', 10)) },
    ])
    expect(logs.get(sha(1))).toMatchObject({ machine: 'laptop-b', line: { analyzer: '0.1.7+cccc' } })
    expect(logs.get(sha(2))).toMatchObject({ machine: 'laptop-a', line: { analyzer: '0.1.5+dddd' } })
  })
})

describe('which logs an event file holds', () => {
  // Saturday and Sunday of event TEST, a pit run on Saturday, a practice day five days before, and an older event.
  const q1 = match(1), q2 = match(2), q40 = match(40, { offsetMin: 24 * 60 + 20 })
  const pit = match(0, { onField: false, label: 'pit-sat', offsetMin: 5 })
  const practice = match(0, { onField: false, label: 'practice', offsetMin: -5 * 24 * 60 })
  const older = { ...match(9, { offsetMin: -40 * 24 * 60, label: 'older-q9' }), event: 'OLD' }
  const sessions = groupSessions([older, practice, q1, pit, q2, q40])

  it("are the latest event's matches and its pit runs by day, nothing from a practice day or an earlier event", () => {
    const s = latestEventSession(sessions)!
    expect(s.matches.map((m) => m.fileName)).toEqual(['q1.wpilog', 'q2.wpilog', 'q40.wpilog'])
    expect(eventLogNames(s).sort()).toEqual(['pit-sat.wpilog', 'q1.wpilog', 'q2.wpilog', 'q40.wpilog'])
  })

  it('a line per log, keyed by the library sha-256, with the analyzer id of its profile and code folder, and no marks inside', () => {
    const marked = match(2, { fires: [{ key: 'mech/test · Arm', wrongMark: true }] })
    const withCode = { ...q1, codeFolder: 'robot-code' }
    const shas = new Map([['q1.wpilog', sha(1)], ['q2.wpilog', sha(2)]])
    const lines = eventLines({ summaries: [withCode, marked, q40], names: ['q1.wpilog', 'q2.wpilog', 'q40.wpilog'], shaOf: (n) => shas.get(n) ?? null, version: '0.1.9', analyzerHash: 'hash', at: BASE })
    // q40 has no library record (its sha is unknown): no line
    expect(lines.map((l) => l.summary.fileName)).toEqual(['q1.wpilog', 'q2.wpilog'])
    expect(lines[0].analyzer).toBe(analyzerId('0.1.9', 'hash', withCode.robot.profileId, true))
    expect(lines[1].analyzer).toBe(analyzerId('0.1.9', 'hash', marked.robot.profileId, false))
    expect(lines[0].analyzer).not.toBe(lines[1].analyzer)
    expect(JSON.stringify(lines)).not.toContain('wrongMark')
    expect(JSON.stringify(lines)).not.toContain('test reason')
  })

  it('the analyzer id changes with the analyzer, the profile and the code folder, not with anything else', () => {
    const base = analyzerId('0.1.9', 'h1', 'Test robot @ main', false)
    expect(analyzerId('0.1.9', 'h1', 'Test robot @ main', false)).toBe(base)
    expect(base).toMatch(/^0\.1\.9\+[0-9a-f]{8}$/)
    for (const other of [analyzerId('0.1.9', 'h2', 'Test robot @ main', false), analyzerId('0.1.9', 'h1', 'Other robot', false), analyzerId('0.1.9', 'h1', 'Test robot @ main', true)]) expect(other).not.toBe(base)
  })
})

describe('the analyzer hash', () => {
  it('is set by the build from what summarizing a log imports, not the whole source', async () => {
    const { ANALYZER_HASH } = await import('../src/hub/event-publish.ts')
    const { describerHash, sourceHash } = await import('../vite.build-id.ts')
    expect(ANALYZER_HASH).toBe(describerHash(['src/session/summary.ts']))
    expect(ANALYZER_HASH).not.toBe(sourceHash())
  })
})
