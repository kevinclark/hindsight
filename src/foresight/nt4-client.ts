/**
 * A read-only NetworkTables 4 client for Foresight, the pit check. Spec:
 * https://github.com/wpilibsuite/allwpilib/blob/main/ntcore/doc/networktables4.adoc
 *
 * Two rules, enforced here and tested (tests/foresight-client.test.ts):
 *
 * 1. **It cannot write to the robot.** Everything sent goes through `controlFrame`, which allows only `subscribe` and
 *    `unsubscribe`. It never publishes, never sets properties, and never sends a binary (value) frame, not even
 *    NT4's clock-sync ping: values are placed by the robot's own timestamps, so no clock sync is needed.
 * 2. **It never runs on the field** (once the robot is on the FMS the laptop runs only the team's match setup). On connecting it subscribes to the field guard's topics first. The moment either
 *    says the field (FMS) is attached, it closes the socket and refuses to connect again until the page is reloaded.
 *    It also closes, failing safe, when no guard value has arrived within GUARD_WAIT_MS, when a guard topic carries
 *    a value of an unexpected type, or when a frame from the robot can't be decoded: it can't tell where it is.
 *    `guardClear` is true only once a guard value saying "not attached" has arrived; nothing is judged before.
 */
import { decodeMsgpackStream } from './msgpack.ts'
import { FMS_ATTACHED_BIT, GUARD_CONTROL_DATA, GUARD_FMS_ATTACHED } from './keys.ts'

export const NT4_PORT = 5810
export const SUBPROTOCOLS = ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu']
export const GUARD_WAIT_MS = 5000
export const FIELD_MESSAGE = 'On the field: close Foresight.'

/** The only messages Foresight ever sends. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set(['subscribe', 'unsubscribe'])

export interface ControlMessage { method: string; params: Record<string, unknown> }

/** The one place a message to the robot is made. Throws for anything but subscribe/unsubscribe. */
export function controlFrame(messages: ControlMessage[]): string {
  for (const m of messages) {
    if (!ALLOWED_METHODS.has(m.method)) throw new Error(`Foresight never sends "${m.method}" to the robot`)
  }
  return JSON.stringify(messages)
}

/** The parts of a browser (or Node) WebSocket the client uses. */
export interface SocketLike {
  binaryType: string
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface Topic { id: number; name: string; type: string }
export interface TopicValue { topic: Topic; /** robot time, seconds */ t: number; value: unknown }

export interface ClientEvents {
  onOpen?: () => void
  onAnnounce?: (topic: Topic) => void
  onValues?: (values: TopicValue[]) => void
  /** The connection ended, with why, in words. Not called after the field guard (onField is). */
  onClose?: (reason: string) => void
  onField?: (message: string) => void
}

export interface SubscribeOptions { periodic?: number; all?: boolean; prefix?: boolean; topicsonly?: boolean }

/** True once the field guard has tripped; only a page reload clears it. */
let fieldLocked = false
export const isFieldLocked = () => fieldLocked
/** Tests only: start a fresh "page". */
export function resetFieldLockForTests(): void { fieldLocked = false }

/** The robot's address as the user typed it: a host, or host:port. */
export function nt4Url(address: string, clientName = 'foresight'): string {
  const a = address.trim()
  return `ws://${/^[^:/]+:\d+$/.test(a) ? a : `${a}:${NT4_PORT}`}/nt/${encodeURIComponent(clientName)}`
}

export class Nt4Client {
  private socket: SocketLike | null = null
  private readonly topics = new Map<number, Topic>()
  private nextSubuid = 1
  private guardTimer: ReturnType<typeof setTimeout> | null = null
  private guardValueSeen = false
  private closedByUs = false

  private readonly url: string
  private readonly events: ClientEvents
  private readonly makeSocket: (url: string, protocols: string[]) => SocketLike

  constructor(url: string, events: ClientEvents, makeSocket?: (url: string, protocols: string[]) => SocketLike) {
    this.url = url
    this.events = events
    this.makeSocket = makeSocket ?? ((u, p) => new WebSocket(u, p) as unknown as SocketLike)
  }

  connect(): void {
    if (fieldLocked) throw new Error(`${FIELD_MESSAGE} (reload the page to use Foresight again in the pit)`)
    const socket = this.makeSocket(this.url, SUBPROTOCOLS)
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      // The guard first, before anything else is asked for.
      this.subscribe([GUARD_FMS_ATTACHED, GUARD_CONTROL_DATA], { all: true, periodic: 0.1 })
      this.guardTimer = setTimeout(() => {
        if (!this.guardValueSeen) this.end('The robot sent no value saying whether the field is attached (/AdvantageKit/DriverStation/FMSAttached or /FMSInfo/FMSControlData), so Foresight cannot tell it is in the pit. Disconnected.')
      }, GUARD_WAIT_MS)
      this.events.onOpen?.()
    }
    socket.onmessage = (ev) => this.receive(ev.data)
    socket.onerror = () => { /* onclose follows with the reason */ }
    socket.onclose = (ev) => {
      this.clearGuardTimer()
      if (fieldLocked || this.closedByUs) return
      this.events.onClose?.(`Connection closed${ev.reason ? `: ${ev.reason}` : ev.code ? ` (code ${ev.code})` : ''}`)
    }
  }

  /** True once a field-guard value saying "not attached" has arrived (and the guard hasn't tripped since). */
  get guardClear(): boolean {
    return this.guardValueSeen && !fieldLocked
  }

  /** Subscribe to topics (exact names, or name prefixes with `prefix: true`). Returns the subscription id. */
  subscribe(topics: string[], options: SubscribeOptions): number {
    const subuid = this.nextSubuid++
    this.send([{ method: 'subscribe', params: { topics, subuid, options } }])
    return subuid
  }

  unsubscribe(subuid: number): void {
    this.send([{ method: 'unsubscribe', params: { subuid } }])
  }

  /** Close the connection (the user clicked Disconnect). */
  close(): void {
    this.closedByUs = true
    this.clearGuardTimer()
    this.socket?.close()
    this.socket = null
  }

  private send(messages: ControlMessage[]): void {
    const frame = controlFrame(messages) // throws before anything leaves for a method that isn't allowed
    if (this.socket && this.socket.readyState === 1) this.socket.send(frame)
  }

  private end(reason: string): void {
    this.close()
    this.events.onClose?.(reason)
  }

  private clearGuardTimer(): void {
    if (this.guardTimer) clearTimeout(this.guardTimer)
    this.guardTimer = null
  }

  private tripFieldGuard(): void {
    fieldLocked = true
    this.closedByUs = true
    this.clearGuardTimer()
    this.socket?.close()
    this.socket = null
    this.events.onField?.(FIELD_MESSAGE)
  }

  private receive(data: unknown): void {
    if (fieldLocked || !this.socket) return
    if (typeof data === 'string') return this.receiveText(data)
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null
    if (!bytes) return
    let messages: unknown[]
    try {
      messages = decodeMsgpackStream(bytes)
    } catch {
      return this.end('Could not read a frame from the robot, so the field guard could not be checked. Disconnected.')
    }
    const values: TopicValue[] = []
    for (const message of messages) {
      if (!Array.isArray(message) || message.length < 4) continue
      const [id, timestampUs, , value] = message as [number, number, number, unknown]
      const topic = this.topics.get(id)
      if (id < 0 || !topic) continue
      const guard = guardReading(topic.name, value)
      if (guard === 'attached') return this.tripFieldGuard() // drop everything else in this frame
      if (guard === 'unreadable') return this.end(`The robot sent ${topic.name} as ${typeof value}, not the type Foresight expects, so it cannot tell whether the field is attached. Disconnected.`)
      if (guard === 'clear') this.guardValueSeen = true
      values.push({ topic, t: Number(timestampUs) / 1e6, value })
    }
    if (values.length) this.events.onValues?.(values)
  }

  private receiveText(text: string): void {
    let messages: unknown
    try { messages = JSON.parse(text) } catch { return }
    if (!Array.isArray(messages)) return
    for (const m of messages as { method?: string; params?: Record<string, unknown> }[]) {
      const p = m?.params ?? {}
      if (m?.method === 'announce' && typeof p.name === 'string' && typeof p.id === 'number') {
        const topic: Topic = { id: p.id, name: p.name, type: String(p.type ?? '') }
        this.topics.set(topic.id, topic)
        this.events.onAnnounce?.(topic)
      } else if (m?.method === 'unannounce' && typeof p.id === 'number') {
        this.topics.delete(p.id)
      }
    }
  }
}

/**
 * What a value says about the field: 'attached', 'clear' (not attached), 'unreadable' (a guard topic with a value of
 * another type: fail safe), or null for a topic that isn't a guard.
 */
export function guardReading(topic: string, value: unknown): 'attached' | 'clear' | 'unreadable' | null {
  if (topic === GUARD_FMS_ATTACHED) return typeof value === 'boolean' ? (value ? 'attached' : 'clear') : 'unreadable'
  if (topic === GUARD_CONTROL_DATA) return typeof value === 'number' && Number.isInteger(value) ? ((value & FMS_ATTACHED_BIT) !== 0 ? 'attached' : 'clear') : 'unreadable'
  return null
}
