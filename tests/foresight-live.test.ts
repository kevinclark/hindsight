// Foresight end to end without a robot: the CalGames logs replayed as the robot's NT4 stream (tests/helpers/
// nt4-replay-server.ts), read by the real client, store, engine and rules (src/foresight/live.ts).
// Pit mode hides FMSAttached, as in the pit; the field-guard tests replay the logs as they were (FMS attaches at
// 27–29 s robot time in all three).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startReplayServer, type ReplayServer } from './helpers/nt4-replay-server.ts'
import { CALGAMES, haveCalGames } from './helpers/load.ts'
import { ForesightLive, type LiveStatus } from '../src/foresight/live.ts'
import { FIELD_MESSAGE, isFieldLocked, resetFieldLockForTests, type SocketLike } from '../src/foresight/nt4-client.ts'
import { SETTLE_SECONDS } from '../src/foresight/engine.ts'
import { FORESIGHT_PREFIXES, topicFor } from '../src/foresight/keys.ts'

const nodeSocket = (url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as SocketLike
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let server: ReplayServer | null = null
let live: ForesightLive | null = null
beforeEach(() => resetFieldLockForTests())
afterEach(async () => { live?.disconnect(); live = null; await server?.close(); server = null })

/** Replay a log and run Foresight on it until `until(status)` or `maxMs`; every status update is kept. */
async function run(path: string, opts: { pit: boolean; speed: number; until: (s: LiveStatus) => boolean; maxMs?: number }) {
  server = await startReplayServer({ bytes: new Uint8Array(readFileSync(path)), pit: opts.pit, speed: opts.speed })
  const updates: LiveStatus[] = []
  live = new ForesightLive({ address: `127.0.0.1:${server.port}`, lastPassingSha: null, makeSocket: nodeSocket, intervalMs: 200, onUpdate: (s) => updates.push(s) })
  live.start()
  const deadline = Date.now() + (opts.maxMs ?? 30_000)
  while (Date.now() < deadline && !(updates.length && opts.until(updates.at(-1)!))) await sleep(50)
  return { updates, last: updates.at(-1)!, server }
}

const levels = (s: LiveStatus, level: string) => (s.result?.state === 'checked' ? s.result.verdict.items.filter((i) => i.level === level).map((i) => i.finding.rule) : [])
const warnings = (s: LiveStatus) => [...levels(s, 'red'), ...levels(s, 'amber')]
const checkedPast = (t: number) => (s: LiveStatus) => s.result?.state === 'checked' && s.result.end > t

describe.skipIf(!haveCalGames)('Foresight live, replaying CalGames logs in pit mode', () => {
  it('P0: build/dirty fires after settle', async () => {
    const { last } = await run(CALGAMES.p0, { pit: true, speed: 20, until: checkedPast(12.18 + SETTLE_SECONDS + 5) })
    expect(last.state).toBe('connected')
    expect(last.codeStartFrom).toBe('metadata')
    expect(last.codeStart).toBeCloseTo(12.18, 1)
    expect(last.profile?.code.branch).toBe('event-calgames') // the branch P0 ran, not main
    expect(warnings(last)).toContain('build/dirty')
  })

  it('Q21: power/rest-voltage fires, 12.43–12.48 V', async () => {
    const { last } = await run(CALGAMES.q21, { pit: true, speed: 20, until: checkedPast(11.76 + SETTLE_SECONDS + 15) })
    expect(warnings(last)).toEqual(['power/rest-voltage'])
    const f = last.result?.state === 'checked' ? last.result.verdict.items[0].finding : null
    expect(f?.measured?.[0].value).toBeGreaterThanOrEqual(12.43)
    expect(f?.measured?.[0].value).toBeLessThanOrEqual(12.48)
  })

  it('Q13: nothing amber or red from settle to the first enable; no finding at all before settle', async () => {
    const { updates } = await run(CALGAMES.q13, { pit: true, speed: 60, until: (s) => s.result?.state === 'enabled', maxMs: 30_000 })
    const checked = updates.filter((s) => s.result?.state === 'checked')
    expect(checked.length).toBeGreaterThan(10)
    expect(checked.flatMap(warnings)).toEqual([])
    // Before settle the result is a countdown, never findings, so no camera alert from start-up can show.
    const early = updates.filter((s) => s.robotTime !== null && s.robotTime < 11.88 + SETTLE_SECONDS)
    expect(early.length).toBeGreaterThan(0)
    expect(early.every((s) => s.result === null || s.result.state === 'settling')).toBe(true)
    expect(updates.at(-1)!.result?.state).toBe('enabled') // reached the first enable at 270 s
  }, 40_000)

  it('sends only subscribe and unsubscribe, never a binary frame', async () => {
    const { server } = await run(CALGAMES.p0, { pit: true, speed: 20, until: checkedPast(45) })
    live!.disconnect()
    await sleep(100)
    expect(server.received.filter((f) => f.kind === 'binary')).toEqual([])
    const methods = server.received.flatMap((f) => (f.data as { method: string }[]).map((m) => m.method))
    expect(new Set(methods)).toEqual(new Set(['subscribe']))
    // Only the guard, the metadata, the profile's keys and the companion's /Hindsight keys: never the whole tree.
    const subscribes = server.received.flatMap((f) => f.data as { params: { topics: string[]; options: { prefix?: boolean } } }[])
    const topics = subscribes.flatMap((m) => m.params.topics)
    // 107 for the 2026 robot (of ~455 it publishes): 66 before motor temperatures, readings and camera results.
    expect(topics.length).toBeLessThan(120)
    // The one prefix subscription is the Hindsight companion's own keys (its device keys name each device).
    const prefixed = subscribes.filter((m) => m.params.options.prefix).flatMap((m) => m.params.topics)
    expect(prefixed).toEqual(FORESIGHT_PREFIXES.map(topicFor))
    expect(prefixed).toEqual(['/AdvantageKit/Hindsight/'])
  })
})

describe.skipIf(!haveCalGames)('Foresight field guard, replaying CalGames logs as they were', () => {
  for (const [name, path, attach] of [['Q13', CALGAMES.q13, 28.47], ['Q21', CALGAMES.q21, 27.76], ['P0', CALGAMES.p0, 27.27]] as const) {
    it(`${name}: closes the socket when FMSAttached turns true (${attach} s) and never reconnects`, async () => {
      const { updates, last, server } = await run(path, { pit: false, speed: 10, until: (s) => s.state === 'field' })
      expect(last.state).toBe('field')
      expect(last.message).toBe(FIELD_MESSAGE)
      expect(last.result).toBeNull()
      // It saw no value from after the attach: the last robot time it knew is before it.
      // Nothing from after the attach reached the store (values later in the same frame are dropped too).
      expect(live!.store.latest).toBeGreaterThan(attach - 1)
      expect(live!.store.latest).toBeLessThanOrEqual(attach)
      expect(updates.some((s) => s.result?.state === 'checked')).toBe(false)
      expect(isFieldLocked()).toBe(true)
      // The server sees the socket close, and a new attempt is refused without connecting.
      const framesBefore = server.received.length
      const again: LiveStatus[] = []
      new ForesightLive({ address: `127.0.0.1:${server.port}`, lastPassingSha: null, makeSocket: nodeSocket, onUpdate: (s) => again.push(s) }).start()
      await sleep(500)
      expect(again.at(-1)!.state).not.toBe('connected')
      expect(again.at(-1)!.message).toMatch(/On the field/)
      expect(server.received.length).toBe(framesBefore)
    })
  }
})
