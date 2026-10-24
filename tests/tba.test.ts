// The Blue Alliance client, event identity and event days. Team 9999 and events 2099test / 2099next / 2099other are invented; the fake fetch answers from tables below.
import { describe, expect, it } from 'vitest'
import { createTba, isTbaPath, memoryStore, TbaError, ttlOf, type TbaStore } from '../src/tba/source.ts'
import { blankEventClusters, dayIn, identifyEvents, qualNumber, type EventLog } from '../src/tba/identify.ts'
import { groupSessions } from '../src/session/session.ts'
import { gaps, parseSchedule, teamSchedule } from '../src/tba/schedule.ts'
import { checkTbaKey } from '../src/hub/team-setting.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { eventPlaces } from '../src/hub/event-places.ts'
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
  '2099next': qm(5, 12, 21, 28, 35, 42),
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
  it('keeps a finished event\'s match list for 30 days, a running or coming one for 10 minutes', async () => {
    const path = '/team/frc9999/event/2099test/matches/simple'
    const day = 86400e3, end = Date.parse('2099-03-07T00:00:00Z')
    expect(ttlOf(path, end + 3 * day, '2099-03-07')).toBe(30 * day)
    expect(ttlOf(path, end + 1 * day, '2099-03-07')).toBe(10 * 60e3) // fetched while it may still be running
    expect(ttlOf(path, end + 9 * day)).toBe(10 * 60e3) // the caller does not know the end
    expect(ttlOf('/event/2099test', 0)).toBe(day)
    const calls: string[] = [], store = memoryStore()
    let t = end + 5 * day
    const get = createTba({ key: KEY, store, fetch: fakeFetch(calls), now: () => t })
    await get(path, { eventEnd: '2099-03-07' })
    t += 20 * day
    await get(path, { eventEnd: '2099-03-07' })
    expect(calls).toHaveLength(1)
    t += 11 * day
    await get(path, { eventEnd: '2099-03-07' })
    expect(calls).toHaveLength(2)
    // a copy made during the event is fetched again once, afterwards
    const during = memoryStore()
    t = end
    await createTba({ key: KEY, store: during, fetch: fakeFetch(calls), now: () => t })(path, { eventEnd: '2099-03-07' })
    t = end + 5 * day
    await createTba({ key: KEY, store: during, fetch: fakeFetch(calls), now: () => t })(path, { eventEnd: '2099-03-07' })
    expect(calls).toHaveLength(4)
  })
  it('checks a typed key without repeating it', () => {
    expect(checkTbaKey('abc_DEF-1234567890xyz')).toBe('abc_DEF-1234567890xyz')
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
    const near = await run(quals('2099-03-06', 5, 12))
    expect(near.byFile.get('q5-2099-03-06')).toMatchObject({ key: '2099test', by: 'date' })
    const far = await run(quals('2099-04-02', 5, 12))
    expect(far.byFile.get('q5-2099-04-02')).toMatchObject({ key: '2099next', by: 'date' })
    // exactly halfway between the two events' midpoints
    const mid = (Date.parse('2099-03-06T00:00:00Z') + Date.parse('2099-04-02T00:00:00Z')) / 2
    const tie = await run([{ fileName: 'x', playedAt: mid, onField: true, event: '', matchLabel: 'Qualification 5' }, { fileName: 'y', playedAt: mid + 3600e3, onField: true, event: '', matchLabel: 'Qualification 12' }])
    expect(tie.clusters[0]).toMatchObject({ why: 'tie', event: null })
    // one shared number is no evidence for the robot clock to decide on
    expect((await run(quals('2099-03-06', 5))).clusters[0]).toMatchObject({ why: 'tie', event: null })
  })
  it('looks in the year either side', async () => {
    const r = await run(quals('2099-10-12', 3, 12, 20))
    expect(r.byFile.get('q3-2099-10-12')).toMatchObject({ key: '2098old' })
  })
  it('a refused key is said to be refused, not unreachable', async () => {
    const r = await run(quals('2099-03-05', 5, 12), fakeFetch([], { status: 401 }))
    expect(r.clusters[0]).toMatchObject({ why: 'refused', event: null })
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
  it('a rename made to the old blank-event session still applies; one on the new id wins', () => {
    const logs = [onField('a', '2099-01-10T18:00:00Z', 'Qualification 5')]
    const day = (() => { const d = new Date(Date.parse('2099-01-10T18:00:00Z')); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    expect(groupSessions(logs, {}, { [`event::${day}`]: 'Our event' }, found('a'))[0].label).toBe('Our event')
    const id = groupSessions(logs, {}, {}, found('a'))[0].id
    expect(groupSessions(logs, {}, { [`event::${day}`]: 'Old', [id]: 'New' }, found('a'))[0].label).toBe('New')
  })
  it('an event the robot clock chose is labelled a guess', () => {
    const guess = new Map([['a', { ...found('a').get('a')!, by: 'date' as const, clockOffsetDays: 0 }]])
    expect(groupSessions([onField('a', '2099-03-05T18:00:00Z', 'Qualification 5')], {}, {}, guess)[0].label).toBe('Event Test Regional 2099 (guess)')
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

describe('the team schedule', () => {
  // invented: times in seconds since 1970 from a base, spaced in minutes
  const base = Date.UTC(2099, 2, 5, 17) / 1000
  const row = (n: number, minutes: number | null, extra: Record<string, unknown> = {}) => ({ key: `2099x_qm${n}`, comp_level: 'qm', set_number: 1, match_number: n, time: minutes === null ? null : base + minutes * 60, ...extra })
  const day = (starts: number[], first: number) => starts.map((m, i) => row(first + i, m))
  // Saturday: 50, 130, 75, 55, 40 minutes apart; the night; Sunday: 55 apart; then the playoffs 200 minutes after the last qualification
  const SAT = [0, 50, 180, 255, 310, 350], SUN = [24 * 60 - 60 + 600, 24 * 60 - 60 + 655]
  const raw = [...day(SAT, 2), ...SUN.map((m, i) => row(40 + i, m)), { key: '2099x_sf1m1', comp_level: 'sf', set_number: 4, match_number: 1, time: base + (SUN[1] + 200) * 60 }]

  it('parses in play order and drops what it does not know', () => {
    const s = parseSchedule([...raw].reverse().concat([{ key: 'x', comp_level: 'zz', match_number: 1, set_number: 1, time: null }]))
    expect(s.map((m) => m.key)).toEqual([...raw.map((m) => m.key)])
    expect(s[0]).toMatchObject({ level: 'qm', number: 2, scheduled: base * 1000, predicted: null, actual: null })
  })
  it('gives each gap after a match, with an estimated length, and names lunch, overnight and before playoffs', () => {
    const g = gaps(parseSchedule(raw), 0)
    expect(g.map((x) => [x.after, x.minutes, x.name])).toEqual([
      [2, 50, null], [3, 130, 'lunch'], [4, 75, null], [5, 55, null], [6, 40, null], [7, 24 * 60 - 60 + 600 - 350, 'overnight'], [40, 55, null], [41, 200, 'before playoffs'],
    ])
    expect(g.at(-1)!.next).toEqual({ level: 'sf', number: 1 })
  })
  it('only the gaps after the given match number', () => {
    expect(gaps(parseSchedule(raw), 6).map((x) => x.after)).toEqual([6, 7, 40, 41])
    expect(gaps(parseSchedule(raw), 99)).toEqual([])
  })
  it('a match that has been played counts at its actual time, not the printed one', () => {
    const played = raw.map((m) => (m.match_number === 4 && m.comp_level === 'qm' ? { ...m, actual_time: (m.time ?? 0) + 20 * 60 } : m))
    expect(gaps(parseSchedule(played), 0).find((x) => x.after === 4)!.minutes).toBe(55)
  })
  it('without times it still lists the gaps by match number, with no length', () => {
    const g = gaps(parseSchedule([row(3, null), row(9, null), row(15, null)]), 0)
    expect(g.map((x) => [x.after, x.minutes, x.name])).toEqual([[3, null, null], [9, null, null], [15, null, null]])
  })
  it('a team with no playoff match has no "before playoffs"', () => {
    const g = gaps(parseSchedule(day([0, 50, 100, 160], 1)), 0)
    expect(g.at(-1)).toEqual({ after: 4, next: null, minutes: null, name: null })
    expect(gaps(parseSchedule(raw), 0).at(-1)!.name).toBe('before playoffs')
  })
  it('a day whose gaps are all alike has no lunch, and a day with fewer than three gaps is not judged', () => {
    const even = gaps(parseSchedule(day([0, 60, 120, 180, 240], 1)), 0)
    expect(even.map((x) => x.name)).toEqual([null, null, null, null, null])
    expect(gaps(parseSchedule(day([0, 200, 400], 1)), 0).map((x) => x.name)).toEqual([null, null, null])
  })
  it('reads the team\'s matches through the client, with the time they were fetched', async () => {
    const got = await teamSchedule(createTba({ key: KEY, store: memoryStore(), fetch: fakeFetch(), now: () => 42 }), 9999, '2099test')
    expect(got).toMatchObject({ fetchedAt: 42, fromCache: false })
    expect(got.data.map((m) => m.key)).toEqual(['2099x_qm5', '2099x_qm12', '2099x_qm19', '2099x_qm26', '2099x_qm33', '2099x_qm40', '2099test_sf1m1'])
  })
})

describe('the Library\'s place for pit runs', () => {
  const rec = (sha256: string, iso: string, over: Record<string, unknown> = {}) => ({ record: { sha256, kind: 'wpilog', stub: false, onField: false, event: '', playedAt: Date.parse(iso), robot: null, ...over }, tags: {} }) as unknown as Entry
  const tz = 'America/Los_Angeles'
  const ev = { key: '2099test', name: 'Test Regional', start: '', end: '', timezone: tz, clockOffsetDays: 0, matched: 1, of: 1, by: 'quals' as const, fetchedAt: 1, fromCache: false }
  it('gives pit runs on an identified event\'s local days the event, and agrees with the Session view', () => {
    const entries = [rec('f', '2099-03-06T04:00:00Z', { onField: true }), rec('late', '2099-03-06T06:00:00Z'), rec('morning', '2099-03-05T16:00:00Z'), rec('nextday', '2099-03-06T20:00:00Z')]
    const places = eventPlaces(entries, new Map([['f', ev]]))
    expect([...places].sort()).toEqual([['f', 'Test Regional 2099'], ['late', 'Test Regional 2099'], ['morning', 'Test Regional 2099']])
    // the Session view's answer for the same four logs
    const s = groupSessions([onField('f', '2099-03-06T04:00:00Z', 'Qualification 5'), summary('late', '2099-03-06T06:00:00Z'), summary('morning', '2099-03-05T16:00:00Z'), summary('nextday', '2099-03-06T20:00:00Z')], {}, {}, new Map([['f', ev]]))
    expect(s.find((x) => x.kind === 'event')!.pitRuns!.map((m) => m.fileName).sort()).toEqual(['late', 'morning'])
  })
  it('does the same for an FMS-named event, with no lookup', () => {
    const entries = [rec('f', '2099-03-05T18:00:00Z', { onField: true, event: 'TEST' }), rec('pit', '2099-03-05T12:00:00Z'), rec('stub', '2099-03-05T12:00:00Z', { stub: true }), rec('other', '2099-03-20T12:00:00Z')]
    expect([...eventPlaces(entries, new Map())]).toEqual([['pit', 'TEST']])
  })
})
