// The two hard rules of Foresight's NT4 client (src/foresight/nt4-client.ts): it can only subscribe and
// unsubscribe, and it closes for good when the field attaches. Driven through a fake socket.
import { readdirSync, readFileSync } from 'node:fs'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { controlFrame, GUARD_WAIT_MS, Nt4Client, nt4Url, resetFieldLockForTests, isFieldLocked, type ClientEvents, type SocketLike } from '../src/foresight/nt4-client.ts'
import { GUARD_CONTROL_DATA, GUARD_FMS_ATTACHED } from '../src/foresight/keys.ts'

class FakeSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  sent: unknown[] = []
  closed = false
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  readonly url: string
  readonly protocols: string[]
  constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols }
  send(data: unknown) { this.sent.push(data) }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000 }) }
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

function setup(events: ClientEvents = {}) {
  let socket: FakeSocket | null = null
  const client = new Nt4Client('ws://robot:5810/nt/foresight', events, (u, p) => (socket = new FakeSocket(u, p)))
  client.connect()
  return { client, socket: socket! }
}
const announce = (name: string, id: number, type: string) => ({ method: 'announce', params: { name, id, type, properties: {} } })

beforeEach(() => resetFieldLockForTests())
afterEach(() => vi.useRealTimers())

describe('Foresight NT4 client: read-only', () => {
  it('controlFrame refuses everything but subscribe and unsubscribe', () => {
    for (const method of ['publish', 'unpublish', 'setproperties', 'announce', '']) {
      expect(() => controlFrame([{ method, params: {} }])).toThrow(/never sends/)
    }
    expect(() => controlFrame([{ method: 'subscribe', params: {} }, { method: 'publish', params: {} }])).toThrow()
    expect(JSON.parse(controlFrame([{ method: 'unsubscribe', params: { subuid: 1 } }]))).toEqual([{ method: 'unsubscribe', params: { subuid: 1 } }])
  })

  it('sends only JSON text frames of subscribe/unsubscribe through a whole session', () => {
    const { client, socket } = setup()
    socket.open()
    const sub = client.subscribe(['/AdvantageKit/SystemStats/BatteryVoltage'], { all: true, periodic: 0.1 })
    socket.text([announce('/AdvantageKit/SystemStats/BatteryVoltage', 3, 'double'), announce(GUARD_FMS_ATTACHED, 1, 'boolean')])
    socket.values([3, 12_000_000, 1, 12.6], [1, 12_000_000, 0, false], [-1, 5, 2, 7])
    client.unsubscribe(sub)
    client.close()
    expect(socket.sent.length).toBe(3)
    for (const frame of socket.sent) {
      expect(typeof frame).toBe('string')
      for (const m of JSON.parse(frame as string)) expect(['subscribe', 'unsubscribe']).toContain(m.method)
    }
    // The guard is the first thing asked for.
    expect(JSON.parse(socket.sent[0] as string)[0].params.topics).toEqual([GUARD_FMS_ATTACHED, GUARD_CONTROL_DATA])
  })

  it('nothing else in Foresight sends on a socket: one socket send() call, behind controlFrame', () => {
    const files = [
      ...readdirSync('src/foresight').map((f) => `src/foresight/${f}`),
      ...readdirSync('src/ui').filter((f) => /^Foresight/.test(f)).map((f) => `src/ui/${f}`),
    ]
    const sends = files.flatMap((f) => (readFileSync(f, 'utf8').match(/(?<!this)\.send\(/g) ?? []).map(() => f))
    expect(sends).toEqual(['src/foresight/nt4-client.ts'])
    expect(readFileSync('src/foresight/nt4-client.ts', 'utf8')).toMatch(/this\.socket\.send\(frame\)/)
  })

  it('builds the URL from an address, with port 5810 unless one is given', () => {
    expect(nt4Url('10.80.33.2')).toBe('ws://10.80.33.2:5810/nt/foresight')
    expect(nt4Url(' roborio-8033-frc.local ')).toBe('ws://roborio-8033-frc.local:5810/nt/foresight')
    expect(nt4Url('127.0.0.1:5811')).toBe('ws://127.0.0.1:5811/nt/foresight')
  })
})

describe('Foresight NT4 client: field guard', () => {
  it('closes at once when FMSAttached turns true, drops the rest of the frame, and refuses to reconnect', () => {
    const onValues = vi.fn()
    const onField = vi.fn()
    const onClose = vi.fn()
    const { client, socket } = setup({ onValues, onField, onClose })
    socket.open()
    socket.text([announce(GUARD_FMS_ATTACHED, 1, 'boolean'), announce('/AdvantageKit/SystemStats/BatteryVoltage', 2, 'double')])
    socket.values([2, 1_000_000, 1, 12.6], [1, 2_000_000, 0, false])
    expect(onValues).toHaveBeenCalledTimes(1)
    socket.values([2, 3_000_000, 1, 12.5], [1, 3_000_000, 0, true], [2, 3_100_000, 1, 12.4])
    expect(socket.closed).toBe(true)
    expect(onField).toHaveBeenCalledWith(expect.stringMatching(/On the field: close Foresight/))
    expect(onClose).not.toHaveBeenCalled()
    expect(onValues).toHaveBeenCalledTimes(1) // nothing from the frame that carried the attach
    expect(isFieldLocked()).toBe(true)
    expect(() => client.connect()).toThrow(/On the field/)
    expect(() => setup()).toThrow(/On the field/)
  })

  it('trips on WPILib FMSControlData bit 4 too, not on other bits', () => {
    const onField = vi.fn()
    const { socket } = setup({ onField })
    socket.open()
    socket.text([announce(GUARD_CONTROL_DATA, 7, 'int')])
    socket.values([7, 1, 2, 0b100011]) // enabled, auto, DS attached
    expect(onField).not.toHaveBeenCalled()
    socket.values([7, 2, 2, 0b110000]) // FMS + DS attached
    expect(onField).toHaveBeenCalled()
    expect(socket.closed).toBe(true)
  })

  it('a robot already on the field trips it on the first value', () => {
    const onField = vi.fn()
    const { socket } = setup({ onField })
    socket.open()
    socket.text([announce(GUARD_FMS_ATTACHED, 1, 'boolean')])
    socket.values([1, 1, 0, true])
    expect(onField).toHaveBeenCalled()
  })

  it('closes when the robot publishes neither guard topic', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const { socket } = setup({ onClose })
    socket.open()
    socket.text([announce('/AdvantageKit/SystemStats/BatteryVoltage', 2, 'double')])
    vi.advanceTimersByTime(GUARD_WAIT_MS + 1)
    expect(socket.closed).toBe(true)
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/cannot tell it is in the pit/))
  })
})

describe('Foresight NT4 client: failing safe', () => {
  it('a guard topic announced but never sent a value: closes after the wait, and guardClear never turns true', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const { client, socket } = setup({ onClose })
    socket.open()
    socket.text([announce(GUARD_FMS_ATTACHED, 1, 'boolean')])
    expect(client.guardClear).toBe(false)
    vi.advanceTimersByTime(GUARD_WAIT_MS + 1)
    expect(socket.closed).toBe(true)
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/sent no value/))
  })

  it('guardClear only after a value saying "not attached"', () => {
    const { client, socket } = setup()
    socket.open()
    socket.text([announce(GUARD_FMS_ATTACHED, 1, 'boolean')])
    socket.values([1, 1, 0, false])
    expect(client.guardClear).toBe(true)
  })

  it('a guard value of another type (an int FMSAttached) disconnects instead of reading blind', () => {
    const onClose = vi.fn()
    const { socket } = setup({ onClose })
    socket.open()
    socket.text([announce(GUARD_FMS_ATTACHED, 1, 'int')])
    socket.values([1, 1, 2, 1])
    expect(socket.closed).toBe(true)
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/not the type Foresight expects/))
  })

  it('a frame it cannot decode disconnects (the guard value might have been in it)', () => {
    const onClose = vi.fn()
    const onValues = vi.fn()
    const { socket } = setup({ onClose, onValues })
    socket.open()
    socket.onmessage?.({ data: new Uint8Array([0x94, 0x01, 0xc1]).buffer })
    expect(socket.closed).toBe(true)
    expect(onValues).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/Could not read a frame/))
  })
})
