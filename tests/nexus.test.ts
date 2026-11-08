// The Nexus client and its times. Team numbers 9999.. and event 2099test are invented; the fake fetch answers from a table.
import { describe, expect, it } from 'vitest'
import { checkNexusKey, createNexus, isNexusEventKey, NEXUS_TTL_MS, NexusError, type NexusEvent, type NexusMatch } from '../src/nexus/source.ts'
import { matchKeyOf, nexusTimes, withNexus } from '../src/nexus/times.ts'
import { memoryStore } from '../src/tba/source.ts'
import { startOf, type ScheduledMatch } from '../src/tba/schedule.ts'

const KEY = 'nx-secret-key-0123456789'
const match = (label: string, over: Partial<NexusMatch> = {}): NexusMatch => ({
  label, status: 'Queuing soon', redTeams: ['9999', '9998', '9997'], blueTeams: ['9996', '9995', '9994'], replayOf: null, breakAfter: null, times: {}, ...over,
})
const EVENT: NexusEvent = {
  eventKey: '2099test', dataAsOfTime: 1_000, nowQueuing: 'Qualification 1', announcements: [], partsRequests: [],
  matches: [match('Qualification 1')],
}

function fakeFetch(calls: string[] = [], opts: { status?: number; down?: boolean } = {}): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url)
    expect(init?.headers?.['Nexus-Api-Key']).toBe(KEY)
    if (opts.down) throw new TypeError('network down')
    const status = opts.status ?? 200
    return { ok: status < 400, status, json: async () => EVENT } as Response
  }) as unknown as typeof fetch
}

describe('the client', () => {
  it('sends the key in the header and caches the answer under /event/{key}', async () => {
    const calls: string[] = [], store = memoryStore()
    const got = await createNexus({ key: KEY, store, fetch: fakeFetch(calls), now: () => 5 })('2099test')
    expect(got).toMatchObject({ fetchedAt: 5, fromCache: false })
    expect(calls).toEqual(['https://frc.nexus/api/v1/event/2099test'])
    expect(store.map.get('/event/2099test')?.at).toBe(5)
  })
  it('keeps a copy for less than the minute Now waits between reads', () => expect(NEXUS_TTL_MS).toBeLessThan(60_000))
  it('serves a copy younger than NEXUS_TTL_MS (under Now\'s one-minute read) without asking, then asks again', async () => {
    const calls: string[] = [], store = memoryStore()
    let t = 1_000
    const get = createNexus({ key: KEY, store, fetch: fakeFetch(calls), now: () => t })
    await get('2099test')
    t += NEXUS_TTL_MS - 1
    expect(await get('2099test')).toMatchObject({ fetchedAt: 1_000, fromCache: true })
    expect(calls).toHaveLength(1)
    t += 1
    expect(await get('2099test')).toMatchObject({ fromCache: false })
    expect(calls).toHaveLength(2)
  })
  it('throws a refused key even when a copy exists', async () => {
    const store = memoryStore()
    await createNexus({ key: KEY, store, fetch: fakeFetch(), now: () => 0 })('2099test')
    for (const status of [401, 403]) {
      const err = await createNexus({ key: KEY, store, fetch: fakeFetch([], { status }), now: () => 1e6 })('2099test').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(NexusError)
      expect(err).toMatchObject({ message: 'Nexus did not accept the API key.', status })
    }
  })
  it('throws a 404 even when a copy exists', async () => {
    const store = memoryStore()
    await createNexus({ key: KEY, store, fetch: fakeFetch(), now: () => 0 })('2099test')
    const err = await createNexus({ key: KEY, store, fetch: fakeFetch([], { status: 404 }), now: () => 1e6 })('2099test').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'This event is not on Nexus.', status: 404 })
  })
  it('names another refusal by its status', async () => {
    const err = await createNexus({ key: KEY, store: memoryStore(), fetch: fakeFetch([], { status: 418 }) })('2099test').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'Nexus answered 418.', status: 418 })
  })
  it('offline, 5xx or 429, the saved copy answers', async () => {
    const store = memoryStore()
    await createNexus({ key: KEY, store, fetch: fakeFetch(), now: () => 0 })('2099test')
    for (const opts of [{ down: true }, { status: 500 }, { status: 429 }]) {
      const got = await createNexus({ key: KEY, store, fetch: fakeFetch([], opts), now: () => 1e6 })('2099test')
      expect(got).toMatchObject({ fetchedAt: 0, fromCache: true })
      expect(got.data.eventKey).toBe('2099test')
    }
  })
  it('offline with no copy throws in plain words', async () => {
    const err = await createNexus({ key: KEY, store: memoryStore(), fetch: fakeFetch([], { down: true }) })('2099test').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NexusError)
    expect((err as Error).message).toBe('Nexus could not be reached and there is no saved copy.')
  })
  it('never fetches for a bad event key', async () => {
    const calls: string[] = []
    const get = createNexus({ key: KEY, store: memoryStore(), fetch: fakeFetch(calls) })
    for (const bad of ['', 'test', '2099/../x', '2099TEST', '2099test?x=1', 5 as unknown as string]) {
      await expect(get(bad)).rejects.toThrow('Hindsight does not ask Nexus for that.')
    }
    expect(calls).toEqual([])
    expect(isNexusEventKey('2099test')).toBe(true)
    expect(isNexusEventKey('2099')).toBe(false)
  })
  it('never puts the key in the store or an error', async () => {
    const store = memoryStore()
    await createNexus({ key: KEY, store, fetch: fakeFetch() })('2099test')
    expect(JSON.stringify([...store.map])).not.toContain(KEY)
    for (const opts of [{ status: 403 }, { status: 404 }, { status: 500 }, { down: true }]) {
      const err = await createNexus({ key: KEY, store: memoryStore(), fetch: fakeFetch([], opts) })('2099test').catch((e: unknown) => e)
      expect(JSON.stringify(err) + (err as Error).message + (err as Error).stack?.split('\n')[0]).not.toContain(KEY)
    }
  })
})

describe('checkNexusKey', () => {
  it('passes a plausible key trimmed, clears on blank, leaves undefined alone', () => {
    expect(checkNexusKey(`  ${KEY} `)).toBe(KEY)
    expect(checkNexusKey(undefined)).toBeUndefined()
    expect(checkNexusKey(null)).toBeNull()
    expect(checkNexusKey('   ')).toBeNull()
  })
  it('refuses anything else', () => {
    for (const bad of ['short', 'has space inside', 'x'.repeat(257), 'café-key-12345', 12345678]) {
      expect(() => checkNexusKey(bad)).toThrow('That does not look like a Nexus API key: copy the Pull API key from frc.nexus/api.')
    }
  })
})

describe('matchKeyOf', () => {
  it('maps qualifications, playoffs and finals to TBA keys', () => {
    expect(matchKeyOf('Qualification 1')).toBe('qm1')
    expect(matchKeyOf('Qualification 12')).toBe('qm12')
    expect(matchKeyOf('Playoff 1')).toBe('sf1m1')
    expect(matchKeyOf('Playoff 13')).toBe('sf13m1')
    expect(matchKeyOf('Final 1')).toBe('f1m1')
    expect(matchKeyOf('Final 3')).toBe('f1m3')
  })
  it('gives null for practice, replays and anything unknown', () => {
    for (const l of ['Practice 1', 'Practice 6', 'Qualification 2 Replay', 'Playoff 3 Replay', 'Final 1 Replay', 'Qualification 0', 'Qualification', 'Qualification 1.5', 'qualification 1', ' Qualification 1', 'Semifinal 1', '']) {
      expect(matchKeyOf(l)).toBeNull()
    }
  })
})

describe('nexusTimes', () => {
  it('prefers the estimated queue and the actual start, falling back to the other', () => {
    const map = nexusTimes({
      matches: [
        match('Qualification 1', { status: 'On field', times: { estimatedQueueTime: 100, actualQueueTime: 90, estimatedStartTime: 300, actualStartTime: 310 } }),
        match('Qualification 2', { status: 'Now queuing', times: { actualQueueTime: 190, estimatedStartTime: 400 } }),
        match('Qualification 3', { status: 'Mystery', times: { estimatedQueueTime: null, estimatedStartTime: Number.NaN } }),
        match('Final 2', { times: {} }),
      ],
    })
    expect(map.get('qm1')).toEqual({ queue: 100, start: 310, status: 'On field' })
    expect(map.get('qm2')).toEqual({ queue: 190, start: 400, status: 'Now queuing' })
    expect(map.has('qm3')).toBe(false) // no time and no call: no Nexus answer, so The Blue Alliance's line stands
    expect(map.get('f1m2')).toEqual({ queue: null, start: null, status: 'Queuing soon' })
  })
  it('skips practice, replays and anything with replayOf', () => {
    const map = nexusTimes({
      matches: [
        match('Practice 1', { times: { estimatedStartTime: 1 } }),
        match('Qualification 2', { times: { estimatedStartTime: 2 } }),
        match('Qualification 2 Replay', { replayOf: 'Qualification 2', times: { estimatedStartTime: 3 } }),
        match('Qualification 3', { replayOf: 'Qualification 2', times: { estimatedStartTime: 4 } }),
      ],
    })
    expect([...map.keys()]).toEqual(['qm2'])
    expect(map.get('qm2')?.start).toBe(2)
  })
})

describe('withNexus', () => {
  const sm = (key: string, level: ScheduledMatch['level'], number: number, set = 1): ScheduledMatch =>
    ({ key, level, number, set, scheduled: 10, predicted: 20, actual: null })
  const sched = [sm('2099test_qm12', 'qm', 12), sm('2099test_sf8m1', 'sf', 1, 8), sm('2099test_f1m2', 'f', 2)]
  const times = new Map([
    ['qm12', { queue: 1, start: 2, status: 'On deck' as const }],
    ['sf8m1', { queue: 3, start: 4, status: null }],
  ])
  it('joins by the part of the TBA key after the last underscore, keeping order', () => {
    const out = withNexus(sched, times)
    expect(out.map((m) => m.key)).toEqual(sched.map((m) => m.key))
    expect(out[0].nexus).toEqual({ queue: 1, start: 2, status: 'On deck' })
    expect(out[1].nexus).toEqual({ queue: 3, start: 4, status: null })
    expect(out[2].nexus).toBeNull()
    expect(sched[0].nexus).toBeUndefined()
  })
  it('sets null everywhere when there are no times', () => {
    expect(withNexus(sched, null).map((m) => m.nexus)).toEqual([null, null, null])
  })
  it('startOf prefers actual, then nexus.start, then predicted, then scheduled', () => {
    const [m] = withNexus([sm('2099test_qm12', 'qm', 12)], times)
    expect(startOf(m)).toBe(2)
    expect(startOf({ ...m, actual: 5 })).toBe(5)
    expect(startOf({ ...m, nexus: { queue: 1, start: null, status: null } })).toBe(20)
    expect(startOf({ ...m, nexus: null, predicted: null })).toBe(10)
  })
})
