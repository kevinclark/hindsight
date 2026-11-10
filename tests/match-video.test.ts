// The match video link (src/tba/video.ts). Team 9999, event 2099test and the 11-character video keys are invented.
import { describe, expect, it } from 'vitest'
import { matchVideoKey, pickMatch, videoUrl, watchUrl, type TbaMatchFull } from '../src/tba/video.ts'
import { createTba, isTbaPath, memoryStore, ttlOf } from '../src/tba/source.ts'

const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc'
const yt = (key: string) => ({ type: 'youtube', key })
const MATCHES: TbaMatchFull[] = [
  { key: '2099test_qm5', comp_level: 'qm', set_number: 1, match_number: 5, actual_time: 4_000_000, videos: [yt(A)] },
  { key: '2099test_qm12', comp_level: 'qm', set_number: 1, match_number: 12, actual_time: 4_005_000, videos: [] },
  { key: '2099test_qm19', comp_level: 'qm', set_number: 1, match_number: 19, actual_time: 4_010_000, videos: [{ type: 'tba', key: 'xxxxxxxxxxx' }] },
  { key: '2099test_qm26', comp_level: 'qm', set_number: 1, match_number: 26, actual_time: 4_015_000, videos: [{ type: 'tba', key: 'xxxxxxxxxxx' }, yt(B), yt(C)] },
  { key: '2099test_qm33', comp_level: 'qm', set_number: 1, match_number: 33, actual_time: 4_020_000, videos: [yt('short')] },
  { key: '2099test_qm40', comp_level: 'qm', set_number: 1, match_number: 40, actual_time: 4_025_000 },
  { key: '2099test_sf1m1', comp_level: 'sf', set_number: 1, match_number: 1, actual_time: 5_000_000, videos: [yt(A)] },
  { key: '2099test_sf2m1', comp_level: 'sf', set_number: 2, match_number: 1, actual_time: 5_100_000, videos: [yt(B)] },
]

describe('which TBA match, and its video', () => {
  it('a qualification joins on its number', () => {
    expect(pickMatch(MATCHES, 'Qualification', 26, null)?.key).toBe('2099test_qm26')
    expect(pickMatch(MATCHES, 'Qualification', 27, null)).toBeNull()
  })
  it('an elimination joins on the nearest actual_time, inside 180 s only', () => {
    expect(pickMatch(MATCHES, 'Elimination', 3, 5_000_179)?.key).toBe('2099test_sf1m1')
    expect(pickMatch(MATCHES, 'Elimination', 3, 5_100_000 - 100)?.key).toBe('2099test_sf2m1')
    expect(pickMatch(MATCHES, 'Elimination', 3, 5_000_181)).toBeNull()
    expect(pickMatch(MATCHES, 'Elimination', 3, null)).toBeNull()
  })
  it('an elimination never joins a qualification that is close in time', () => {
    expect(pickMatch(MATCHES, 'Elimination', 3, 4_000_000)).toBeNull()
  })
  it('practice and anything else: no match', () => {
    expect(pickMatch(MATCHES, 'Practice' as never, 5, 4_000_000)).toBeNull()
  })
})

describe('the video key', () => {
  const key = async (label: string, start: number | null, matches = MATCHES) =>
    matchVideoKey(async () => ({ data: matches, fetchedAt: 0, fromCache: false }) as never, 9999, '2099test', undefined, label, start)
  it('a YouTube video makes a key; the first one wins; other kinds are skipped', async () => {
    expect(await key('Qualification 5', null)).toBe(A)
    expect(await key('Qualification 26', null)).toBe(B)
  })
  it('no video, a non-YouTube video, a bad key, or no field data: nothing', async () => {
    for (const label of ['Qualification 12', 'Qualification 19', 'Qualification 33', 'Qualification 40', 'Qualification 99', 'Practice 3', '']) expect(await key(label, null)).toBeNull()
  })
  it('a key that is not 11 URL-safe characters never reaches a URL', async () => {
    const bad = (k: string): TbaMatchFull[] => [{ key: 'q', comp_level: 'qm', set_number: 1, match_number: 1, videos: [yt(k)] }]
    for (const k of ['a b cccccc', 'aaaaaaaaaa"', 'aaaaaaaaaaaa', 'aaaaaaaaaa/', '']) expect(await key('Qualification 1', null, bad(k))).toBeNull()
    expect(await key('Qualification 1', null, bad('a_b-cD3fGh9'))).toBe('a_b-cD3fGh9')
  })
  it('an elimination is found by time', async () => {
    expect(await key('Elimination 7', 5_100_050)).toBe(B)
    expect(await key('Elimination 7', 5_500_000)).toBeNull()
  })
  it('a failed lookup gives no link, not an error', async () => {
    expect(await matchVideoKey(async () => { throw new Error('x') }, 9999, '2099test', undefined, 'Qualification 5', null)).toBeNull()
  })
})

describe('the links', () => {
  it('the match link opens at the start', () => expect(videoUrl(A)).toBe(`https://www.youtube.com/watch?v=${A}`))
  it('a finding link opens at floor(matchTime) seconds', () => {
    expect(watchUrl(A, { matchTime: 83.9 })).toBe(`https://www.youtube.com/watch?v=${A}&t=83s`)
    expect(watchUrl(A, { matchTime: 0.4 })).toBe(`https://www.youtube.com/watch?v=${A}&t=0s`)
  })
  it('no link for a whole-match finding, a negative time, a run (off the field) or no video', () => {
    expect(watchUrl(A, { matchTime: null })).toBeNull()
    expect(watchUrl(A, { matchTime: -2.5 })).toBeNull()
    expect(watchUrl(A, { matchTime: 30, run: 2 })).toBeNull()
    expect(watchUrl(null, { matchTime: 30 })).toBeNull()
  })
})

describe('the client allows the full match list, and only that', () => {
  const path = '/team/frc9999/event/2099test/matches'
  it('the path list', () => {
    expect(isTbaPath(path)).toBe(true)
    expect(isTbaPath('/team/frc9999/event/2099test/matches/simple')).toBe(true)
    for (const bad of ['/team/frc9999/event/2099test/matches/keys', '/team/frc9999/event/2099test/matches?x=1', '/team/frc9999/event/2099test/matches/', '/team/frc9999/event/2099test/teams', '/event/2099test/matches']) expect(isTbaPath(bad)).toBe(false)
  })
  it('keeps the list as long as the simple one', () => {
    const day = 86400e3, end = Date.parse('2099-03-07T00:00:00Z')
    expect(ttlOf(path, end + 3 * day, '2099-03-07')).toBe(30 * day)
    expect(ttlOf(path, end + 1 * day, '2099-03-07')).toBe(10 * 60e3)
    expect(ttlOf(path, 0)).toBe(10 * 60e3)
  })
  it('createTba asks for it', async () => {
    const calls: string[] = []
    const fetch = (async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => MATCHES } }) as unknown as typeof globalThis.fetch
    const got = await createTba({ key: 'k'.repeat(64), store: memoryStore(), fetch })(path)
    expect(got.data).toHaveLength(MATCHES.length)
    expect(calls).toEqual([`https://www.thebluealliance.com/api/v3${path}`])
  })
})
