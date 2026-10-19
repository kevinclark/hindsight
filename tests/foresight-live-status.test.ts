// Foresight never leaves a verdict up that is no longer current: not after the connection closes, not when the robot
// stops sending, and not before the field guard has said "not attached". Driven through a fake socket and fake clock.
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForesightLive, STALE_MS, type LiveStatus } from '../src/foresight/live.ts'
import { resetFieldLockForTests, type SocketLike } from '../src/foresight/nt4-client.ts'
import { GUARD_FMS_ATTACHED, topicFor } from '../src/foresight/keys.ts'

class FakeSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  send() {}
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.({}) }
  text(messages: object[]) { this.onmessage?.({ data: JSON.stringify(messages) }) }
  values(...messages: unknown[][]) {
    const parts = messages.map((m) => encode(m))
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) { all.set(p, o); o += p.length }
    this.onmessage?.({ data: all.buffer })
  }
}

const TOPICS: [string, string][] = [
  [GUARD_FMS_ATTACHED, 'boolean'], [topicFor('/Timestamp'), 'int'], [topicFor('/RealMetadata/Codebase'), 'string'],
  [topicFor('/RealMetadata/GitBranch'), 'string'], [topicFor('/DriverStation/Enabled'), 'boolean'], [topicFor('/SystemStats/BatteryVoltage'), 'double'],
]
const id = (name: string) => TOPICS.findIndex(([n]) => n === name) + 1
const us = (s: number) => Math.round(s * 1e6)

let socket: FakeSocket
let updates: LiveStatus[]
let live: ForesightLive
beforeEach(() => {
  resetFieldLockForTests()
  vi.useFakeTimers()
  updates = []
  live = new ForesightLive({ address: 'robot', lastPassingSha: null, intervalMs: 1000, onUpdate: (s) => updates.push(s), makeSocket: () => (socket = new FakeSocket()) })
  live.start()
  socket.open()
  socket.text(TOPICS.map(([name, type], i) => ({ method: 'announce', params: { name, id: i + 1, type, properties: {} } })))
})
afterEach(() => vi.useRealTimers())

/** The robot has been up since 10 s and it is now 100 s robot time: settled, so a verdict is due. */
function robotSends(guard = true) {
  const values: unknown[][] = [
    [id(topicFor('/RealMetadata/Codebase')), us(10), 4, '2026 Offseason'], [id(topicFor('/RealMetadata/GitBranch')), us(10), 4, 'main'],
    [id(topicFor('/DriverStation/Enabled')), us(10), 0, false], [id(topicFor('/SystemStats/BatteryVoltage')), us(100), 1, 12.7],
    [id(topicFor('/Timestamp')), us(100), 2, us(100)],
  ]
  if (guard) values.unshift([id(GUARD_FMS_ATTACHED), us(10), 0, false])
  socket.values(...values)
}
const last = () => updates.at(-1)!

describe('Foresight live status', () => {
  it('no verdict before the guard has said "not attached"', () => {
    robotSends(false)
    vi.advanceTimersByTime(1000)
    expect(last().result).toBeNull()
    socket.values([id(GUARD_FMS_ATTACHED), us(100), 0, false])
    vi.advanceTimersByTime(1000)
    expect(last().result?.state).toBe('checked')
  })

  it('withdraws the verdict when the robot stops sending, and brings it back when data returns', () => {
    robotSends()
    vi.advanceTimersByTime(1000)
    expect(last().result?.state).toBe('checked')
    vi.advanceTimersByTime(STALE_MS + 1000)
    expect(last().result).toBeNull()
    expect(last().message).toMatch(/No data from the robot for \d+ s/)
    socket.values([id(topicFor('/Timestamp')), us(105), 2, us(105)])
    vi.advanceTimersByTime(1000)
    expect(last().result?.state).toBe('checked')
    expect(last().message).toMatch(/^Connected\. Robot:/)
  })

  it('withdraws the verdict when the connection closes', () => {
    robotSends()
    vi.advanceTimersByTime(1000)
    expect(last().result?.state).toBe('checked')
    socket.onclose?.({ code: 1006 })
    expect(last().state).toBe('closed')
    expect(last().result).toBeNull()
  })
})
