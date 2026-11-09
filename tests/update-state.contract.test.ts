// Contract tests for the update chip's state machine: each test proves the obligations its name starts with, in
// docs/contracts/update-state.md. Pure functions, made-up versions and times.
import { describe, expect, test } from 'vitest'
import { CHECK_EVERY_MS, STALL_MS, chip, initial, step, type UpdateEvent, type UpdateState } from '../src/hub/update-state.ts'

const V = '0.1.100'
const T0 = 1_762_000_000_000
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const events: UpdateEvent[] = [
  { type: 'checking' }, { type: 'none' }, { type: 'available', next: '0.1.101' },
  { type: 'progress', transferred: 5, total: 10, bytesPerSecond: 1 }, { type: 'downloaded', next: '0.1.101' },
  { type: 'error', reason: 'offline' }, { type: 'manual', next: '0.1.101', url: 'https://example.com/r' },
]
const downloading = (over: Partial<Extract<UpdateState, { kind: 'downloading' }>> = {}): UpdateState =>
  ({ kind: 'downloading', version: V, next: '0.1.101', transferred: 41e6, total: 123e6, bytesPerSecond: 2.1e6, lastDataAt: T0, ...over })
const ready: UpdateState = { kind: 'ready', version: V, next: '0.1.101' }
const current: UpdateState = { kind: 'current', version: V, checkedAt: T0 }
const failed: UpdateState = { kind: 'failed', version: V, checkedAt: T0, since: T0 + 10, reason: 'offline' }
const manual: UpdateState = { kind: 'manual', version: V, next: '0.1.101', url: 'https://example.com/r', checkedAt: T0 }

describe('[US-01] start', () => {
  test('[US-01] an unpackaged build that does not self-update is dev; everything else starts checking', () => {
    expect(initial(V, false, false)).toEqual({ kind: 'dev', version: V })
    expect(initial(V, true, false)).toEqual({ kind: 'checking', version: V, checkedAt: null })
    expect(initial(V, true, true)).toEqual({ kind: 'checking', version: V, checkedAt: null })
    expect(initial(V, false, true)).toEqual({ kind: 'checking', version: V, checkedAt: null })
  })
  test('[US-01] dev ignores every event', () => {
    const dev = initial(V, false, false)
    for (const e of events) expect(step(dev, e, T0)).toEqual(dev)
  })
})

describe('[US-02] ready is sticky', () => {
  test('[US-02] checking, none, error, progress and manual leave ready unchanged', () => {
    for (const e of events.filter((x) => x.type !== 'available' && x.type !== 'downloaded')) expect(step(ready, e, T0 + 5)).toEqual(ready)
  })
  test('[US-02] an available or downloaded that is not newer leaves ready unchanged', () => {
    expect(step(ready, { type: 'available', next: '0.1.101' }, T0)).toEqual(ready)
    expect(step(ready, { type: 'available', next: '0.1.99' }, T0)).toEqual(ready)
    expect(step(ready, { type: 'downloaded', next: '0.1.101' }, T0)).toEqual(ready)
    expect(step(ready, { type: 'downloaded', next: '0.1.99' }, T0)).toEqual(ready)
  })
})

describe('[US-03] a newer release replaces what is offered', () => {
  test('[US-03] from ready, a newer available downloads and a newer downloaded is ready', () => {
    expect(step(ready, { type: 'available', next: '0.1.102' }, T0 + 7)).toEqual(downloading({ next: '0.1.102', transferred: 0, total: 0, bytesPerSecond: 0, lastDataAt: T0 + 7 }))
    expect(step(ready, { type: 'downloaded', next: '0.1.102' }, T0)).toEqual({ kind: 'ready', version: V, next: '0.1.102' })
  })
  test('[US-03] from other states available downloads and downloaded is ready; the same download keeps its progress', () => {
    for (const s of [initial(V, true, true), current, failed, manual]) {
      expect(step(s, { type: 'available', next: '0.1.101' }, T0 + 3)).toMatchObject({ kind: 'downloading', next: '0.1.101', transferred: 0, lastDataAt: T0 + 3 })
      expect(step(s, { type: 'downloaded', next: '0.1.101' }, T0)).toEqual(ready)
    }
    const d = downloading()
    expect(step(d, { type: 'available', next: '0.1.101' }, T0 + 9)).toEqual(d)
    expect(step(d, { type: 'downloaded', next: '0.1.101' }, T0)).toEqual(ready)
  })
})

describe('[US-04] checking and none', () => {
  test('[US-04] checking keeps the last successful check; none sets it to now', () => {
    expect(step(initial(V, true, true), { type: 'checking' }, T0)).toEqual({ kind: 'checking', version: V, checkedAt: null })
    expect(step(current, { type: 'checking' }, T0 + 99)).toEqual({ kind: 'checking', version: V, checkedAt: T0 })
    expect(step({ kind: 'checking', version: V, checkedAt: T0 }, { type: 'checking' }, T0 + 99)).toEqual({ kind: 'checking', version: V, checkedAt: T0 })
    expect(step({ kind: 'checking', version: V, checkedAt: null }, { type: 'none' }, T0 + 5)).toEqual({ kind: 'current', version: V, checkedAt: T0 + 5 })
    expect(step(failed, { type: 'none' }, T0 + 5)).toEqual({ kind: 'current', version: V, checkedAt: T0 + 5 })
  })
  test('[US-04] a checking event changes nothing while failed, downloading or manual', () => {
    for (const s of [failed, downloading(), manual]) expect(step(s, { type: 'checking' }, T0 + 1)).toEqual(s)
  })
})

describe('[US-05] errors', () => {
  test('[US-05] a first error from checking, current or downloading is failed with since now and the last success', () => {
    expect(step({ kind: 'checking', version: V, checkedAt: T0 }, { type: 'error', reason: 'x' }, T0 + 4)).toEqual({ kind: 'failed', version: V, checkedAt: T0, since: T0 + 4, reason: 'x' })
    expect(step({ kind: 'checking', version: V, checkedAt: null }, { type: 'error', reason: 'x' }, T0 + 4)).toMatchObject({ kind: 'failed', checkedAt: null, since: T0 + 4 })
    expect(step(current, { type: 'error', reason: 'x' }, T0 + 4)).toEqual({ kind: 'failed', version: V, checkedAt: T0, since: T0 + 4, reason: 'x' })
    expect(step(downloading(), { type: 'error', reason: 'x' }, T0 + 4)).toEqual({ kind: 'failed', version: V, checkedAt: null, since: T0 + 4, reason: 'x' })
  })
  test('[US-05] an error while failed keeps since and the last success, and takes the new reason', () => {
    expect(step(failed, { type: 'error', reason: 'later' }, T0 + 5000)).toEqual({ ...failed, reason: 'later' })
  })
  test('[US-05] a success ends the run: the next error starts a new since', () => {
    const ok = step(failed, { type: 'none' }, T0 + 100)
    expect(step(ok, { type: 'error', reason: 'y' }, T0 + 200)).toMatchObject({ since: T0 + 200, checkedAt: T0 + 100 })
  })
  test('[US-05] manual ignores an error', () => {
    expect(step(manual, { type: 'error', reason: 'x' }, T0 + 1)).toEqual(manual)
  })
})

describe('[US-06] progress', () => {
  test('[US-06] lastDataAt moves only when transferred grew', () => {
    const grew = step(downloading(), { type: 'progress', transferred: 50e6, total: 123e6, bytesPerSecond: 3e6 }, T0 + 2000)
    expect(grew).toEqual(downloading({ transferred: 50e6, bytesPerSecond: 3e6, lastDataAt: T0 + 2000 }))
    const same = step(grew, { type: 'progress', transferred: 50e6, total: 123e6, bytesPerSecond: 0 }, T0 + 9000)
    expect(same).toEqual(downloading({ transferred: 50e6, bytesPerSecond: 0, lastDataAt: T0 + 2000 }))
  })
  test('[US-06] progress outside downloading is ignored', () => {
    for (const s of [current, failed, manual]) expect(step(s, { type: 'progress', transferred: 1, total: 2, bytesPerSecond: 1 }, T0)).toEqual(s)
  })
})

describe('[US-07] manual', () => {
  test('[US-07] manual gives manual with the link and the time, from checking, current or failed', () => {
    for (const s of [initial(V, false, true), current, failed]) {
      expect(step(s, { type: 'manual', next: '0.1.101', url: 'https://example.com/r' }, T0 + 8)).toEqual({ ...manual, checkedAt: T0 + 8 })
    }
  })
})

describe('[US-08] timing constants', () => {
  test('[US-08] a check every 4 hours; a stall after 15 seconds', () => {
    expect(CHECK_EVERY_MS).toBe(4 * 60 * 60 * 1000)
    expect(STALL_MS).toBe(15_000)
  })
})

describe('[US-09] chip: dev, checking, current', () => {
  test('[US-09] the first three labels', () => {
    expect(chip({ kind: 'dev', version: V }, T0, null)).toMatchObject({ text: `${V} · dev build`, action: null, accent: false })
    expect(chip({ kind: 'checking', version: V, checkedAt: null }, T0, null)).toMatchObject({ text: `${V} · checking…`, action: null, accent: false })
    expect(chip(current, T0 + 60_000, null)).toMatchObject({ text: `${V} · up to date, checked ${time(T0)}`, action: null, accent: false })
  })
  test('[US-09] current with an unseen changelog says what is new, accented', () => {
    expect(chip(current, T0, V)).toMatchObject({ text: `Updated to ${V} · What's new`, action: 'whatsnew', accent: true })
    expect(chip(current, T0, '0.1.99').text).toBe(`${V} · up to date, checked ${time(T0)}`)
  })
})

describe('[US-10] chip: downloading', () => {
  test('[US-10] megabytes, rounded', () => {
    expect(chip(downloading(), T0 + 3000, null)).toMatchObject({ text: 'Downloading 0.1.101 · 41 of 123 MB', action: null, accent: false })
    expect(chip(downloading({ transferred: 41.6e6 }), T0, null).text).toBe('Downloading 0.1.101 · 42 of 123 MB')
    expect(chip(downloading({ transferred: 0, total: 0 }), T0, null).text).toBe('Downloading 0.1.101')
  })
  test('[US-10] after the stall time with no new data the words say so', () => {
    expect(chip(downloading(), T0 + STALL_MS - 1, null).text).toBe('Downloading 0.1.101 · 41 of 123 MB')
    expect(chip(downloading(), T0 + 37_000, null).text).toBe('Downloading 0.1.101 · no data for 37 s')
  })
})

describe('[US-11] chip: ready, failed, manual', () => {
  test('[US-11] wording, action and accent', () => {
    expect(chip(ready, T0, null)).toMatchObject({ text: '0.1.101 ready · Restart to update', action: 'restart', accent: true })
    expect(chip(failed, T0 + 1e6, null)).toMatchObject({ text: `${V} · couldn't check since ${time(T0 + 10)} · Retry`, action: 'retry', accent: false })
    expect(chip(manual, T0, null)).toMatchObject({ text: '0.1.101 is out · Download', action: 'download', accent: false })
  })
  test('[US-11] only ready and the what\'s-new label are accented', () => {
    const all: [UpdateState, string | null][] = [[{ kind: 'dev', version: V }, null], [initial(V, true, true), null], [current, null], [downloading(), null], [failed, null], [manual, null]]
    for (const [s, w] of all) expect(chip(s, T0 + 20_000, w).accent).toBe(false)
    expect([chip(ready, T0, null).accent, chip(current, T0, V).accent]).toEqual([true, true])
  })
})

describe('[US-12] chip titles', () => {
  test('[US-12] plain words naming the versions, ending in a full stop; ready says it installs on quit', () => {
    const states: [UpdateState, string[]][] = [
      [{ kind: 'dev', version: V }, [V]], [initial(V, true, true), [V]], [current, [V]], [downloading(), [V, '0.1.101']],
      [ready, ['0.1.101']], [failed, [V]], [manual, ['0.1.101']],
    ]
    for (const [s, names] of states) {
      const { title } = chip(s, T0 + 20_000, null)
      expect(title).toMatch(/\.$/)
      for (const n of names) expect(title).toContain(n)
    }
    expect(chip(ready, T0, null).title).toBe('Hindsight 0.1.101 is downloaded. Restart now, or it installs the next time you quit.')
  })
})
