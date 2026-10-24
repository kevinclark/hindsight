// The Blue Alliance client, event identity and event days. Team 9999 and events 2099test / 2099next / 2099other are invented; the fake fetch answers from tables below.
import { describe, expect, it } from 'vitest'
import { createTba, isTbaPath, memoryStore, TbaError, type TbaStore } from '../src/tba/source.ts'
import { blankEventClusters, dayIn, identifyEvents, qualNumber, type EventLog } from '../src/tba/identify.ts'
import { groupSessions } from '../src/session/session.ts'
import { checkTbaKey } from '../src/hub/team-setting.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { facetValues, type RobotLabels } from '../src/hub/facets.ts'
import type { Entry } from '../src/hub/catalog.ts'

const KEY = 'k'.repeat(64)
const qm = (...numbers: number[]) => numbers.map((n) => ({ key: `2099x_qm${n}`, comp_level: 'qm', set_number: 1, match_number: n }))
const EVENTS: Record<string, { key: string; name: string; start_date: string; end_date: string; timezone?: string }[]> = {
  '2099': [
    { key: '2099test', name: 'Test Regional', start_date: '2099-03-05', end_date: '2099-03-07', timezone: 'America/Los_Angeles' },
    { key: '2099next', name: 'Next Regional', start_date: '2099-04-01', end_date: '2099-04-03', timezone: 'America/Denver' },
  ],
  '2098': [{ key: '2098old', name: 'Old Regional', start_date: '2098-10-10', end_date: '2098-10-11', timezone: 'America/Los_Angeles' }],
  '2100': [],
}
const MATCHES: Record<string, ReturnType<typeof qm>> = {
  '2099test': [...qm(5, 12, 19, 26, 33, 40), { key: '2099test_sf1m1', comp_level: 'sf', set_number: 1, match_number: 1 }],
  '2099next': qm(5, 14, 21, 28, 35, 42),
  '2098old': qm(3, 12, 20, 27),
}

function fakeFetch(calls: string[] = [], opts: { status?: number; down?: boolean } = {}): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url)
    expect(init?.headers?.['X-TBA-Auth-Key']).toBe(KEY)
    if (opts.down) throw new TypeError('network down')
    const path = url.replace('https://www.thebluealliance.com/api/v3', '')
    const body = (b: unknown) => ({ ok: opts.status === undefined || opts.status < 400, status: opts.status ?? 200, json: async () => b }) as Response
    if (opts.status && opts.status >= 400) return body(null)
    let m
    if ((m = /^\/team\/frc9999\/events\/(\d{4})\/simple$/.exec(path))) return body((EVENTS[m[1]] ?? []).map(({ timezone: _t, ...e }) => e))
    if ((m = /^\/event\/(\w+)$/.exec(path))) return body(Object.values(EVENTS).flat().find((e) => e.key === m![1]))
    if ((m = /^\/team\/frc9999\/event\/(\w+)\/matches\/simple$/.exec(path))) return body(MATCHES[m[1]] ?? [])
    return { ok: false, status: 404, json: async () => null } as Response
  }) as unknown as typeof fetch
}

describe('the client', () => {
  it('asks for only the three reads', () => {
    expect(isTbaPath('/team/frc9999/events/2099/simple')).toBe(true)
    expect(isTbaPath('/event/2099test')).toBe(true)
    expect(isTbaPath('/team/frc9999/event/2099test/matches/simple')).toBe(true)
    for (const bad of ['/events/2099', '/team/frc9999', '/event/2099test/teams', '/team/frc9999/events/2099/simple?x=1', 'https://example.com', 5]) expect(isTbaPath(bad)).toBe(false)
  })
  it('caches every answer with its fetch time and serves a fresh copy without asking again', async () => {
    const calls: string[] = [], store = memoryStore()
    let t = 1_000
    const get = createTba({ key: KEY, store, fetch: fakeFetch(calls), now: () => t })
    const a = await get('/event/2099test')
    expect(a).toMatchObject({ fetchedAt: 1_000, fromCache: false })
    t = 5_000
    expect(await get('/event/2099test')).toMatchObject({ fetchedAt: 1_000, fromCache: true })
    expect(calls).toHaveLength(1)
    expect(store.map.get('/event/2099test')?.at).toBe(1_000)
  })
  it('never writes the key into the cache', async () => {
    const store = memoryStore()
    await createTba({ key: KEY, store, fetch: fakeFetch() })('/team/frc9999/events/2099/simple')
    expect(JSON.stringify([...store.map])).not.toContain(KEY)
  })
  it('offline, the saved copy answers and says when it was fetched', async () => {
    const store = memoryStore()
    await createTba({ key: KEY, store, fetch: fakeFetch(), now: () => 1_000 })('/team/frc9999/event/2099test/matches/simple')
    const later = createTba({ key: KEY, store, fetch: fakeFetch([], { down: true }), now: () => 99 * 3600e3 })
    const got = await later<unknown[]>('/team/frc9999/event/2099test/matches/simple')
    expect(got).toMatchObject({ fetchedAt: 1_000, fromCache: true })
    expect(got.data).toHaveLength(7)
  })
  it('offline with no copy throws in plain words, without the key', async () => {
    const err = await createTba({ key: KEY, store: memoryStore(), fetch: fakeFetch([], { down: true }) })('/event/2099test').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TbaError)
    expect((err as Error).message).toBe('The Blue Alliance could not be reached and there is no saved copy.')
  })
  it('a refused key is reported even when a copy exists', async () => {
    const store = memoryStore()
    await createTba({ key: KEY, store, fetch: fakeFetch(), now: () => 0 })('/event/2099test')
    const err = await createTba({ key: KEY, store, fetch: fakeFetch([], { status: 401 }), now: () => 99 * 3600e3 })('/event/2099test').catch((e: unknown) => e)
    expect((err as Error).message).toBe('The Blue Alliance did not accept the read key.')
  })
  it('a store that fails to read or write does not stop the answer', async () => {
    const broken: TbaStore = { read: async () => { throw new Error('x') }, write: async () => { throw new Error('y') } }
    expect((await createTba({ key: KEY, store: broken, fetch: fakeFetch() })('/event/2099test')).data).toMatchObject({ key: '2099test' })
  })
  it('checks a typed key without repeating it', () => {
    expect(checkTbaKey(undefined)).toBeUndefined()
    expect(checkTbaKey('')).toBeNull()
    expect(checkTbaKey(null)).toBeNull()
    expect(checkTbaKey(` ${KEY} `)).toBe(KEY)
    expect(() => checkTbaKey('has spaces and !!')).toThrow(/does not look like/)
    try { checkTbaKey('bad key!') } catch (e) { expect((e as Error).message).not.toContain('bad key') }
  })
})

const at = (iso: string) => Date.parse(iso)
const log = (fileName: string, iso: string, label: string, over: Partial<EventLog> = {}): EventLog => ({ fileName, playedAt: at(iso), onField: true, event: '', matchLabel: label, ...over })

describe('event identity', () => {
  const quals = (iso: string, ...n: number[]) => n.map((q, i) => log(`q${q}-${iso}`, `${iso}T${String(18 + i).padStart(2, '0')}:00:00Z`, `Qualification ${q}`))
  const run = (logs: EventLog[], fetchImpl = fakeFetch()) => identifyEvents(logs, 9999, createTba({ key: KEY, store: memoryStore(), fetch: fetchImpl, now: () => 7 }))

  it('reads a qualification label, and no other', () => {
    expect(qualNumber('Qualification 49')).toBe(49)
    for (const no of ['Practice 3', 'Playoff 2', '', 'Qualification', 'Qualification 4 (2 logs)']) expect(qualNumber(no)).toBeNull()
  })
  it('clusters as grouping does: blank-event on-field logs, each within 4 days of the last', () => {
    const logs = [...quals('2099-03-05', 5, 12), ...quals('2099-03-08', 19), ...quals('2099-04-20', 5), log('named', '2099-03-05T10:00:00Z', 'Qualification 5', { event: 'test' }), log('pit', '2099-03-05T12:00:00Z', '', { onField: false })]
    expect(blankEventClusters(logs).map((c) => c.length)).toEqual([3, 1])
  })
  it('chooses the event whose list holds the cluster\'s quals, and records its zone and the clock offset', async () => {
    // the robot clock says 2099-01-10 for an event on 2099-03-05..07: the clock is 54 days early
    const r = await run(quals('2099-01-10', 5, 12, 19, 26))
    expect(r.clusters[0]).toMatchObject({ why: null, quals: [5, 12, 19, 26] })
    expect(r.byFile.get('q5-2099-01-10')).toMatchObject({ key: '2099test', name: 'Test Regional', timezone: 'America/Los_Angeles', clockOffsetDays: 54, matched: 4, of: 4, by: 'quals', fromCache: false })
  })
  it('offset is 0 when the clock puts the day inside the event', async () => {
    expect((await run(quals('2099-03-06', 5, 12, 19))).byFile.get('q5-2099-03-06')!.clockOffsetDays).toBe(0)
  })
  it('needs 80 % of the cluster\'s quals: 4 of 5 is enough, 3 of 5 is not', async () => {
    expect((await run(quals('2099-03-05', 5, 12, 19, 26, 99))).clusters[0]).toMatchObject({ why: null, event: { matched: 4, of: 5 } })
    expect((await run(quals('2099-03-05', 5, 12, 19, 98, 99))).clusters[0]).toMatchObject({ why: 'no event', event: null, candidates: ['2099test'] })
  })
  it('does not match on playoff numbers, and leaves other labels alone', async () => {
    const logs = [log('p', '2099-03-05T18:00:00Z', 'Playoff 1'), log('s', '2099-03-05T19:00:00Z', 'Semifinal 1')]
    expect((await run(logs)).clusters[0]).toMatchObject({ why: 'no quals', event: null })
  })
  it('when two events hold as many, the date breaks the tie; when it cannot, it says tie', async () => {
    // 5 is in both 2099test and 2099next; 2098old has neither
    const near = await run(quals('2099-03-06', 5))
    expect(near.byFile.get('q5-2099-03-06')).toMatchObject({ key: '2099test', by: 'date' })
    const far = await run(quals('2099-04-02', 5))
    expect(far.byFile.get('q5-2099-04-02')).toMatchObject({ key: '2099next', by: 'date' })
    // exactly halfway between the two events' midpoints
    const mid = (Date.parse('2099-03-06T00:00:00Z') + Date.parse('2099-04-02T00:00:00Z')) / 2
    const tie = await run([{ fileName: 'x', playedAt: mid, onField: true, event: '', matchLabel: 'Qualification 5' }])
    expect(tie.clusters[0]).toMatchObject({ why: 'tie', event: null })
  })
  it('looks in the year either side', async () => {
    const r = await run(quals('2099-10-12', 3, 12, 20))
    expect(r.byFile.get('q3-2099-10-12')).toMatchObject({ key: '2098old' })
  })
  it('a cluster TBA cannot be asked about says so and changes nothing; the others still resolve', async () => {
    const r = await run(quals('2099-03-05', 5, 12), fakeFetch([], { down: true }))
    expect(r.clusters[0]).toMatchObject({ why: 'unreachable', event: null })
    expect(r.byFile.size).toBe(0)
  })
  it('asks nothing when no log needs an event', async () => {
    const calls: string[] = []
    const r = await run([log('n', '2099-03-05T18:00:00Z', 'Qualification 5', { event: 'test' })], fakeFetch(calls))
    expect(calls).toEqual([])
    expect(r.clusters).toEqual([])
  })
  it('gives the local day in the event\'s zone', () => {
    // 2099-03-06 03:00Z is still the 5th in Los Angeles
    expect(dayIn(at('2099-03-06T03:00:00Z'), 'America/Los_Angeles')).toBe('2099-03-05')
    expect(dayIn(at('2099-03-06T03:00:00Z'), 'Etc/UTC')).toBe('2099-03-06')
  })
})

const summary = (fileName: string, iso: string, over: Partial<MatchSummary> = {}) => ({ fileName, playedAt: at(iso), onField: false, event: '', matchLabel: '', rules: {}, ...over }) as unknown as MatchSummary
const onField = (fileName: string, iso: string, label: string, event = '') => summary(fileName, iso, { onField: true, matchLabel: label, event })

describe('event days', () => {
  const found = (...files: string[]) => new Map(files.map((f) => [f, { key: '2099test', name: 'Test Regional', start: '2099-03-05', end: '2099-03-07', timezone: 'America/Los_Angeles', clockOffsetDays: 54, matched: 4, of: 4, by: 'quals' as const, fetchedAt: 1, fromCache: false }]))

  it('with no resolved events nothing changes from the plain grouping, except that a pit run on an event day joins the event', () => {
    const s = groupSessions([onField('a', '2099-03-05T18:00:00Z', 'Qualification 5'), summary('pit', '2099-03-05T12:00:00Z'), summary('other', '2099-03-20T12:00:00Z')])
    expect(s.map((x) => [x.kind, x.matches.map((m) => m.fileName), x.pitRuns?.map((m) => m.fileName)])).toEqual([['event', ['a'], ['pit']], ['practice', ['other'], undefined]])
  })
  it('names the session from the resolved event, keeps the clock note, and records the event', () => {
    const [s] = groupSessions([onField('a', '2099-01-10T18:00:00Z', 'Qualification 5'), onField('b', '2099-01-10T19:00:00Z', 'Qualification 12')], {}, {}, found('a', 'b'))
    expect(s.label).toBe('Event Test Regional 2099 (robot clock 54 days off)')
    expect(s.id).toBe('event:test:' + s.id.split(':')[2])
    expect(s.event?.key).toBe('2099test')
    expect(s.matches).toHaveLength(2)
  })
  it('a log with an FMS name is never re-labelled by a resolution, and matches by code across the case of the name', () => {
    const [s] = groupSessions([onField('a', '2099-03-05T18:00:00Z', 'Qualification 5', 'TEST'), onField('b', '2099-03-05T19:00:00Z', 'Qualification 12')], {}, {}, found('a', 'b'))
    expect(s.matches.map((m) => m.fileName)).toEqual(['a', 'b'])
    expect(s.label).toBe('Event TEST (' + s.id.split(':')[2] + ')')
  })
  it('pit runs on the days of the event, in the event\'s zone, join it; other days stay practice', () => {
    // Los Angeles: the 5th 20:00 local is 2099-03-06 04:00Z; a laptop in UTC would call it the 6th
    const logs = [onField('a', '2099-03-06T04:00:00Z', 'Qualification 5'), summary('late-pit', '2099-03-06T06:00:00Z'), summary('morning-pit', '2099-03-05T16:00:00Z'), summary('next-day-pit', '2099-03-06T20:00:00Z'), summary('practice', '2099-02-01T20:00:00Z')]
    const s = groupSessions(logs, {}, {}, found('a'))
    expect(s.map((x) => [x.kind, (x.pitRuns ?? x.matches).map((m) => m.fileName).sort()])).toEqual([['practice', ['practice']], ['event', ['late-pit', 'morning-pit']], ['practice', ['next-day-pit']]])
  })
  it('pit runs are not matches: no grid, count or confidence sees them', () => {
    const [s] = groupSessions([onField('a', '2099-03-05T18:00:00Z', 'Qualification 5'), summary('pit', '2099-03-05T12:00:00Z')])
    expect(s.matches.map((m) => m.fileName)).toEqual(['a'])
  })
  it('a log the student moved stays where they put it, pit run or not', () => {
    const s = groupSessions([onField('a', '2099-03-05T18:00:00Z', 'Qualification 5'), summary('pit', '2099-03-05T12:00:00Z')], { pit: 'Bench tests' })
    expect(s.find((x) => x.label === 'Bench tests')!.matches.map((m) => m.fileName)).toEqual(['pit'])
    expect(s.find((x) => x.kind === 'event')!.pitRuns).toBeUndefined()
  })
  it('sessions keep the order of their first log', () => {
    const s = groupSessions([summary('p1', '2099-02-01T12:00:00Z'), onField('a', '2099-03-05T18:00:00Z', 'Qualification 5'), summary('p2', '2099-03-20T12:00:00Z'), summary('nodate', '2099-01-01T00:00:00Z', { playedAt: null })])
    expect(s.map((x) => x.kind)).toEqual(['practice', 'event', 'practice', 'undated'])
  })
})

describe('the Library\'s event facet', () => {
  const entry = (event: string, tag?: string) => ({ record: { sha256: 'abc', onField: true, event, playedAt: Date.UTC(2099, 2, 5), matchType: 2, robot: null }, tags: tag ? { place: tag } : {} }) as unknown as Entry
  const labels: RobotLabels = new Map()
  it('uses the FMS name first, then the event TBA found, then what a person typed', () => {
    const places = new Map([['abc', 'Test Regional 2099']])
    expect(facetValues(entry('', 'my place'), labels, places).place).toBe('Test Regional 2099')
    expect(facetValues(entry('', 'my place'), labels).place).toBe('my place')
    expect(facetValues(entry('XYZ'), labels, places).place).toBe('XYZ')
  })
})
