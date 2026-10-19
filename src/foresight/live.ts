/**
 * Foresight live: connect to the robot over a tether in the pit or queue, keep its values, and check them every second.
 *
 *   1. Connect (nt4-client.ts subscribes to the field guard first).
 *   2. Ask for what the robot says about itself (code name, branch, GitSHA) and the clock; choose its robot profile.
 *   3. Ask for the keys that profile's checks read (keys.ts), every change (`all`), sent in 0.1 s batches.
 *   4. Every second, check the records so far (engine.ts) and report.
 *
 * Robot code start (for the 30 s settle) is the timestamp of the robot's metadata: AdvantageKit publishes it once, as
 * the robot code starts, and the server keeps that timestamp (measured on pyntcore 2025.3.2), so a robot that has been
 * on for 30 s already shows a verdict at once, with no countdown. If no metadata has come, the first value seen counts
 * as the start (so a page opened late waits 30 s it needn't). Both are assumptions to confirm on the first robot.
 */
import { encodePayload } from '../readers/wpilog-writer.ts'
import { PROFILES } from '../profiles/index.ts'
import { chooseProfile } from '../profiles/choose.ts'
import { openWpilog } from '../readers/wpilog.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { RecordStore } from './records.ts'
import { evaluateForesight, type ForesightResult } from './engine.ts'
import { foresightKeys, keyFor, METADATA_KEYS, topicFor, wpilogType } from './keys.ts'
import { isFieldLocked, Nt4Client, nt4Url, type SocketLike, type TopicValue } from './nt4-client.ts'

/** Batch interval asked of the robot (s). With `all`, every change still arrives; this only sets how often. */
export const PERIODIC = 0.1
/** How long to wait for the robot's metadata before choosing a profile without it. */
export const METADATA_WAIT_MS = 3000
/** No value from the robot for this long: the verdict is withdrawn (a pulled tether may not close the socket). */
export const STALE_MS = 3000

export type LiveState = 'connecting' | 'connected' | 'closed' | 'field'

export interface LiveStatus {
  state: LiveState
  message: string
  url: string
  topicsAnnounced: number
  valuesReceived: number
  /** Robot time now (latest value), seconds. */
  robotTime: number | null
  codeStart: number | null
  codeStartFrom: 'metadata' | 'first value' | null
  profile: RobotProfile | null
  subscribed: string[]
  result: ForesightResult | null
}

export interface LiveOptions {
  address: string
  /** The code of the last GO pit check on record. */
  lastPassingSha: string | null
  onUpdate: (status: LiveStatus) => void
  makeSocket?: (url: string, protocols: string[]) => SocketLike
  /** Check every this many ms (default 1000). */
  intervalMs?: number
}

export class ForesightLive {
  readonly store = new RecordStore()
  private readonly client: Nt4Client
  private timer: ReturnType<typeof setInterval> | null = null
  private metaTimer: ReturnType<typeof setTimeout> | null = null
  private readonly types = new Map<string, string>()
  private firstValueAt: number | null = null
  private metadataAt: number | null = null
  private profileChosen = false
  private lastValueWallMs: number | null = null
  /** The "Connected. Robot: …" line, restored after a stale or failed check. */
  private connectedMessage = ''
  readonly status: LiveStatus

  private readonly options: LiveOptions

  constructor(options: LiveOptions) {
    this.options = options
    const url = nt4Url(options.address)
    this.status = {
      state: 'connecting', message: `Connecting to ${url}…`, url, topicsAnnounced: 0, valuesReceived: 0,
      robotTime: null, codeStart: null, codeStartFrom: null, profile: null, subscribed: [], result: null,
    }
    this.client = new Nt4Client(url, {
      onOpen: () => this.opened(),
      onAnnounce: (topic) => {
        this.status.topicsAnnounced++
        this.types.set(topic.name, topic.type)
        const key = keyFor(topic.name)
        const type = wpilogType(topic.type)
        if (key && type) this.store.declare(key, type)
      },
      onValues: (values) => this.received(values),
      onClose: (reason) => this.stop('closed', reason),
      onField: (message) => this.stop('field', message),
    }, options.makeSocket)
  }

  start(): void {
    try {
      this.client.connect()
    } catch (error) {
      this.stop(isFieldLocked() ? 'field' : 'closed', error instanceof Error ? error.message : String(error))
      return
    }
    this.emit()
  }

  /** The user clicked Disconnect. */
  disconnect(): void {
    this.client.close()
    this.stop('closed', 'Disconnected.')
  }

  private opened(): void {
    this.status.state = 'connected'
    this.status.message = 'Connected. Reading what the robot says it is…'
    const first = ['/Timestamp', ...METADATA_KEYS]
    this.client.subscribe(first.map(topicFor), { all: true, periodic: PERIODIC })
    this.status.subscribed = [...first]
    this.metaTimer = setTimeout(() => this.chooseAndSubscribe(), METADATA_WAIT_MS)
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 1000)
    this.emit()
  }

  private received(values: TopicValue[]): void {
    this.lastValueWallMs = Date.now()
    for (const { topic, t, value } of values) {
      this.status.valuesReceived++
      const key = keyFor(topic.name)
      const type = wpilogType(topic.type)
      if (!key || !type) continue
      const payload = encodePayload(type, value)
      if (!payload) continue
      this.store.add(key, type, t, payload)
      if (this.firstValueAt === null || t < this.firstValueAt) this.firstValueAt = t
      if (METADATA_KEYS.includes(key) && (this.metadataAt === null || t < this.metadataAt)) this.metadataAt = t
    }
    // The profile is pinned to a branch, so wait for both the code's name and its branch (or METADATA_WAIT_MS).
    const has = (key: string) => !!this.store.entries.get(key)?.t.length
    if (!this.profileChosen && has('/RealMetadata/Codebase') && has('/RealMetadata/GitBranch')) this.chooseAndSubscribe()
  }

  /** Choose the robot's profile from its metadata, then subscribe to what its checks read. */
  private chooseAndSubscribe(): void {
    if (this.profileChosen || this.status.state !== 'connected') return
    this.profileChosen = true
    if (this.metaTimer) clearTimeout(this.metaTimer)
    const end = Number.isFinite(this.store.latest) ? this.store.latest : 0
    const { profile } = chooseProfile(openWpilog(this.store.windowLog(-Infinity, end)), PROFILES)
    const keys = foresightKeys(profile).filter((k) => !this.status.subscribed.includes(k))
    this.client.subscribe(keys.map(topicFor), { all: true, periodic: PERIODIC })
    this.status.profile = profile
    this.status.subscribed = [...this.status.subscribed, ...keys]
    this.connectedMessage = `Connected. Robot: ${profile.name} (${profile.code.branch}); reading ${this.status.subscribed.length} signals.`
    this.status.message = this.connectedMessage
    this.emit()
  }

  private check(): void {
    if (this.status.state !== 'connected' || !this.profileChosen || !Number.isFinite(this.store.latest)) return this.emit()
    // Nothing is judged until the field guard has said "not attached".
    if (!this.client.guardClear) { this.status.result = null; return this.emit() }
    const silentMs = this.lastValueWallMs === null ? Infinity : Date.now() - this.lastValueWallMs
    if (silentMs > STALE_MS) {
      this.status.result = null
      this.status.message = `No data from the robot for ${Number.isFinite(silentMs) ? Math.round(silentMs / 1000) : '?'} s: check the tether. Nothing is judged until it comes back.`
      return this.emit()
    }
    const codeStart = this.metadataAt ?? this.firstValueAt
    if (codeStart === null) return this.emit()
    this.status.codeStart = codeStart
    this.status.codeStartFrom = this.metadataAt !== null ? 'metadata' : 'first value'
    this.status.robotTime = this.store.latest
    this.store.prune()
    this.status.message = this.connectedMessage
    try {
      this.status.result = evaluateForesight({ store: this.store, codeStart, now: this.store.latest, lastPassingSha: this.options.lastPassingSha, profile: this.status.profile ?? undefined })
    } catch (error) {
      this.status.result = null // never leave an earlier verdict up
      this.status.message = `The check failed: ${error instanceof Error ? error.message : String(error)}`
    }
    this.emit()
  }

  private stop(state: LiveState, message: string): void {
    if (this.timer) clearInterval(this.timer)
    if (this.metaTimer) clearTimeout(this.metaTimer)
    this.timer = null
    if (this.status.state === 'field') return // the field message stays
    this.status.state = state
    this.status.message = message
    this.status.result = null // a verdict is only shown while connected and current
    this.emit()
  }

  private emit(): void {
    this.options.onUpdate({ ...this.status })
  }
}
