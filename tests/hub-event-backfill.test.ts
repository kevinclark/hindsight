// A laptop publishes every event in its library for the phone once: events whose logs this laptop has all published are
// skipped without reading a byte (its own event files are the record); an event with unpublished logs is read one log at a
// time, grouped as the Session view groups, placed with The Blue Alliance, and only the unpublished lines are appended.
// A rules update alone republishes nothing (the phone shows older summaries marked). Invented data only (event TEST).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backfillEvents, eventClusters, type BackfillDeps } from '../src/hub/event-backfill.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { SUMMARY_SHAPE, type MatchSummary } from '../src/session/summary.ts'
import type { Entry } from '../src/hub/catalog.ts'
import type { EventLine } from '../src/hub/event-file.ts'
import { match, BASE } from './helpers/board-scene.ts'

const DAY = 86400e3
const sha = (s: string) => s.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a')
/** A library entry: a log on this laptop. `day` 0 is BASE's day; `n` its qual (on the field) or a pit run. */
function entry(name: string, day: number, n: number, opts: { onField?: boolean; event?: string } = {}): Entry {
  const onField = opts.onField ?? true
  return { record: { type: 'log', kind: 'wpilog', sha256: sha(name), size: 1, path: `logs/x/${name}.wpilog`, names: [`${name}.wpilog`], playedAt: BASE + day * DAY + n * 20 * 60e3, onField, event: onField ? (opts.event ?? 'TEST') : '', stub: false }, names: [`${name}.wpilog`], tags: {}, attached: { dslog: [], dsevents: [], hoot: [] }, local: true, shared: false, toFetch: [] } as unknown as Entry
}
/** The summary a read gives: the board-scene match, named and timed like the entry. */
let qual = 0
const summaryOf = (e: Entry) => ({ ...match(1), metrics: {}, fileName: e.names[0], playedAt: e.record.playedAt, onField: e.record.onField, event: e.record.event, matchLabel: e.record.onField ? `Qualification ${++qual}` : '' }) as unknown as MatchSummary

function deps(entries: Entry[], published: string[], over: Partial<BackfillDeps> = {}) {
  const read: string[] = []
  const appended: { key: string; lines: EventLine[] }[] = []
  const d: BackfillDeps = {
    entries, published: new Set(published),
    read: async (e) => { read.push(e.names[0]); return summaryOf(e) },
    place: async (s) => ({ key: `2099t${Math.floor(((s.matches[0].playedAt ?? 0) - BASE) / DAY) + 100}`, retry: false }),
    append: async (key, lines) => { appended.push({ key, lines }) },
    version: '0.1.700', analyzerHash: 'test', now: () => 5,
    ...over,
  }
  return { d, read, appended }
}

describe('eventClusters', () => {
  it('groups on-field days into events (a gap over 4 days starts a new one), each with its days\' pit runs, newest first', () => {
    const list = [entry('a1', 0, 1), entry('a2', 1, 2), entry('apit', 1, 5, { onField: false }), entry('b1', 30, 1), entry('practice', 20, 1, { onField: false })]
    expect(eventClusters(list).map((c) => c.map((e) => e.names[0]).sort())).toEqual([['b1.wpilog'], ['a1.wpilog', 'a2.wpilog', 'apit.wpilog']])
  })
})

describe('backfillEvents', () => {
  const old = [entry('a1', 0, 1), entry('a2', 0, 2)]
  const recent = [entry('b1', 30, 1), entry('b2', 30, 2)]

  it('skips an event whose logs are all published without reading any, and publishes the other', async () => {
    const { d, read, appended } = deps([...old, ...recent], recent.map((e) => e.record.sha256))
    const done = await backfillEvents(d)
    expect(read.sort()).toEqual(['a1.wpilog', 'a2.wpilog'])
    expect(appended.map((a) => [a.key, a.lines.map((l) => l.sha256)])).toEqual([['2099t100', old.map((e) => e.record.sha256)]])
    expect(appended[0].lines.every((l) => l.shape === SUMMARY_SHAPE && l.analyzer.startsWith('0.1.700+'))).toBe(true)
    expect(done).toEqual({ events: 1, read: 2 })
  })

  it('in a partly published event appends only the unpublished lines (it reads them all, to group them)', async () => {
    const { d, appended } = deps(old, [old[0].record.sha256])
    await backfillEvents(d)
    expect(appended.flatMap((a) => a.lines.map((l) => l.sha256))).toEqual([old[1].record.sha256])
  })

  it('works newest event first, and stops between logs when asked', async () => {
    let stop = false
    const { d, read } = deps([...old, ...recent], [], { read: async (e) => { read.push(e.names[0]); stop = true; return summaryOf(e) }, shouldStop: () => stop })
    await backfillEvents(d)
    expect(read).toEqual(['b1.wpilog'])
  })

  it('logs read and found to belong to no event are recorded, and the next run reads nothing', async () => {
    const marked: string[] = []
    const first = deps(old, [], { place: async () => ({ key: null, retry: false }), markSkipped: async (shas) => { marked.push(...shas) } })
    await backfillEvents(first.d)
    expect(marked.sort()).toEqual(old.map((e) => e.record.sha256).sort())
    const again = deps(old, [], { skipped: new Set(marked) })
    await backfillEvents(again.d)
    expect(again.read).toEqual([])
  })

  it('The Blue Alliance offline or refusing records nothing and stops the pass, so the next run tries again', async () => {
    const marked: string[] = []
    const { d, read } = deps([...old, ...recent], [], { place: async () => ({ key: null, retry: true }), markSkipped: async (shas) => { marked.push(...shas) } })
    await backfillEvents(d)
    expect(marked).toEqual([])
    expect(read.sort()).toEqual(['b1.wpilog', 'b2.wpilog']) // stopped after the first event: the rest would fail the same way
  })

  it('a log that can\'t be read is noted once and does not stop the pass', async () => {
    const marked: string[] = []
    const { d, appended } = deps(old, [], { read: async (e) => { if (e.names[0] === 'a1.wpilog') throw new Error('unreadable'); return summaryOf(e) }, markSkipped: async (shas) => { marked.push(...shas) } })
    await backfillEvents(d)
    expect(appended.flatMap((a) => a.lines.map((l) => l.sha256))).toEqual([old[1].record.sha256])
    expect(marked).toEqual([old[0].record.sha256])
  })

  it('an event The Blue Alliance can\'t place is skipped, not guessed', async () => {
    const { d, appended } = deps(old, [], { place: async () => ({ key: null, retry: false }) })
    await backfillEvents(d)
    expect(appended).toEqual([])
  })
})

describe('what a laptop has published', () => {
  let work: string
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-backfill-')) })
  afterEach(() => rm(work, { recursive: true, force: true }))

  it('is every log in its own event files at the summary shape the phone draws (an older shape is republished)', async () => {
    const lib = await LocalLibrary.open(join(work, 'a'), 'laptop-a')
    const line = (n: number, shape: number): EventLine => ({ sha256: sha(String(n)), analyzer: '0.1.5+aaaa', shape, at: 1, summary: { ...match(n), metrics: {} } as never })
    await lib.appendEvent('2099test', [line(1, SUMMARY_SHAPE), line(2, SUMMARY_SHAPE - 1)].map((l) => `${JSON.stringify(l)}\n`).join(''))
    await lib.appendEvent('2099other', `${JSON.stringify(line(3, SUMMARY_SHAPE))}\n`)
    expect((await lib.publishedShas()).sort()).toEqual([sha('1'), sha('3')].sort())
  })
})

describe('the laptop\'s list of logs looked at', () => {
  it('is kept per summary shape, deduplicated, and reads as empty when damaged', async () => {
    const { readSkipped, writeSkipped } = await import('../src/hub/event-backfill.ts')
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    writeSkipped(store, 4, ['a', 'b', 'a'])
    expect(readSkipped(store, 4)).toEqual(['a', 'b'])
    expect(readSkipped(store, 5)).toEqual([])
    m.set('hindsight.backfill.skipped.4', '{oops')
    expect(readSkipped(store, 4)).toEqual([])
  })
})
