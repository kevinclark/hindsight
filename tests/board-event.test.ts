// Which Blue Alliance event a session is, for the board's schedule: a session whose logs name their event is found by the team's
// qualification numbers, like a blank-event cluster. Team 9999 and events 2099test / 2099next are invented.
import { describe, expect, it } from 'vitest'
import { sessionEvent } from '../src/board/event.ts'
import { teamSchedule } from '../src/tba/schedule.ts'
import { createTba, memoryStore } from '../src/tba/source.ts'
import { match, session } from './helpers/board-scene.ts'

const qm = (...numbers: number[]) => numbers.map((n) => ({ key: `2099x_qm${n}`, comp_level: 'qm', set_number: 1, match_number: n, time: 1_000_000 + n * 600 }))
const EVENTS = [
  { key: '2099test', name: 'Test Regional', start_date: '2099-03-05', end_date: '2099-03-07' },
  { key: '2099next', name: 'Next Regional', start_date: '2099-04-01', end_date: '2099-04-03' },
]
const MATCHES: Record<string, ReturnType<typeof qm>> = { '2099test': qm(2, 3, 4, 5, 6), '2099next': qm(9, 10, 11) }
const fakeFetch = (down = false): typeof fetch => (async (url: string) => {
  if (down) throw new TypeError('network down')
  const path = url.replace('https://www.thebluealliance.com/api/v3', '')
  const body = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response
  let m
  if ((m = /^\/team\/frc9999\/events\/(\d{4})\/simple$/.exec(path))) return body(m[1] === '2099' ? EVENTS : [])
  if ((m = /^\/event\/(\w+)$/.exec(path))) return body({ ...EVENTS.find((e) => e.key === m![1]), timezone: 'America/Los_Angeles' })
  if ((m = /^\/team\/frc9999\/event\/(\w+)\/matches\/simple$/.exec(path))) return body(MATCHES[m[1]] ?? [])
  return { ok: false, status: 404, json: async () => null } as Response
}) as unknown as typeof fetch
const get = (down = false) => createTba({ key: 'k'.repeat(64), store: memoryStore(), fetch: fakeFetch(down), now: () => 7 })

describe('the event of a board session', () => {
  it('a session whose logs name their event is found by the team\'s qualification numbers, and its schedule read', async () => {
    const s = session([match(2), match(3), match(4)])
    expect(s.matches.every((m) => m.event === 'TEST')).toBe(true)
    const g = get()
    const found = await sessionEvent(s, 9999, g)
    expect(found.why).toBeNull()
    expect(found.event).toMatchObject({ key: '2099test', matched: 3, of: 3 })
    const sched = await teamSchedule(g, 9999, found.event!.key, found.event!.end)
    expect(sched.data.map((m) => m.number)).toEqual([2, 3, 4, 5, 6])
  })
  it('a session The Blue Alliance already named keeps its event', async () => {
    const named = { ...session([match(2)]), event: { key: '2099test', name: 'Test Regional', start: '', end: '', timezone: null, clockOffsetDays: 0, matched: 1, of: 1, by: 'quals', fetchedAt: 1, fromCache: false } } as never
    expect((await sessionEvent(named, 9999, get(true))).event?.key).toBe('2099test')
  })
  it('says why when it cannot: numbers no event holds, or no answer and no saved copy', async () => {
    expect((await sessionEvent(session([match(20), match(21)]), 9999, get())).why).toMatch(/no event on the team's list/)
    expect((await sessionEvent(session([match(2), match(3)]), 9999, get(true))).why).toMatch(/could not be reached/)
    expect((await sessionEvent(session([match(2, { onField: false })]), 9999, get())).why).toBeTruthy()
  })
})
