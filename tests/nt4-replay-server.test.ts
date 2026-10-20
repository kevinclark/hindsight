import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { decodeMulti } from '@msgpack/msgpack'
import { startReplayServer, type ReplayOptions, type ReplayServer } from './helpers/nt4-replay-server.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const PROTOCOLS = ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu']
const P = '/AdvantageKit'

interface Announce { name: string; id: number; type: string; properties: object }
type Msg = [number, number, number, unknown]

/** A test client: collects announces and decoded value messages, and can send subscribe / unsubscribe. */
class Client {
  ws: WebSocket
  announces: Announce[] = []
  values: Msg[] = []
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        for (const m of JSON.parse(data.toString())) if (m.method === 'announce') this.announces.push(m.params)
      } else {
        this.values.push(...([...decodeMulti(new Uint8Array(data as Buffer))] as Msg[]))
      }
    })
  }
  send(method: string, params: object): void { this.ws.send(JSON.stringify([{ method, params }])) }
  subscribe(subuid: number, topics: string[], options: object = {}): void { this.send('subscribe', { topics, subuid, options }) }
  idOf(name: string): number { return this.announces.find((a) => a.name === name)?.id ?? -99 }
  valuesOf(name: string): Msg[] { const id = this.idOf(name); return this.values.filter((v) => v[0] === id) }
}

function connect(server: ReplayServer, name = 'test'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.url(name), PROTOCOLS)
    ws.on('open', () => resolve(new Client(ws)))
    ws.on('error', reject)
  })
}

async function until(what: string, check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A 0.6 s match-like log. Times in seconds. */
const ENTRIES: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [0.3, true]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false], [0.3, true]] },
  { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, false], [0.2, true]] },
  { name: '/DriverStation/DSAttached', type: 'boolean', records: [[0, true]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12], [0.1, 12.5], [0.25, 13], [0.4, 12.25], [0.5, 12.75]] },
  { name: '/Test/Count', type: 'int64', records: [[0, -1], [0.1, 300]] },
  { name: '/Test/Gain', type: 'float', records: [[0, 0.5]] },
  { name: '/Test/Names', type: 'string[]', records: [[0, ['a', 'bc']]] },
  { name: '/Test/Hood', type: 'double[]', records: [[0, [1, 2.5] as never]] },
  { name: '/Test/Pose', type: 'struct:Pose2d', records: [[0, { x: 1, y: 2, rot: 3 }]] },
  { name: '/Test/Message', type: 'string', records: [[0, 'hello']] },
  { name: '/Test/Photon', type: 'proto:photonvision.proto.ProtobufPhotonPipelineResult', records: [[0, new Uint8Array([0x20, 0x01])]] },
  { name: '/Test/Odd', type: 'thing', records: [[0, new Uint8Array([1])]] },
]

let server: ReplayServer | null = null
let clients: Client[] = []

async function start(extra: Partial<ReplayOptions> = {}): Promise<ReplayServer> {
  server = await startReplayServer({ bytes: writeWpilog(ENTRIES), ...extra })
  return server
}

afterEach(async () => {
  clients.forEach((c) => c.ws.terminate())
  clients = []
  await server?.close()
  server = null
})

async function open(s: ReplayServer): Promise<Client> {
  const c = await connect(s)
  clients.push(c)
  return c
}

describe('NT4 replay server', () => {
  it('announces matching topics with NT4 type strings, and sends current values', async () => {
    const s = await start({ startAt: 0.15 })
    const c = await open(s)
    c.subscribe(1, [`${P}/SystemStats/BatteryVoltage`, `${P}/Test/Count`])
    c.subscribe(2, [`${P}/Test/`], { prefix: true })
    await until('initial values', () => c.values.length >= 8)
    const types = Object.fromEntries(c.announces.map((a) => [a.name, a.type]))
    expect(types).toEqual({
      [`${P}/SystemStats/BatteryVoltage`]: 'double', [`${P}/Test/Count`]: 'int', [`${P}/Test/Gain`]: 'float',
      [`${P}/Test/Names`]: 'string[]', [`${P}/Test/Hood`]: 'double[]', [`${P}/Test/Pose`]: 'struct:Pose2d',
      [`${P}/Test/Message`]: 'string', [`${P}/Test/Photon`]: 'proto:photonvision.proto.ProtobufPhotonPipelineResult',
    })
    expect(new Set(c.announces.map((a) => a.id)).size).toBe(c.announces.length)
    expect(c.announces.every((a) => Object.keys(a.properties).length === 0)).toBe(true)
    const first = (n: string) => c.valuesOf(`${P}/${n}`)[0]
    expect(first('SystemStats/BatteryVoltage').slice(1)).toEqual([100000, 1, 12.5]) // latest at or before 0.15 s
    expect(first('Test/Count').slice(1)).toEqual([100000, 2, 300])
    expect(first('Test/Gain').slice(1)).toEqual([0, 3, 0.5])
    expect(first('Test/Names').slice(1)).toEqual([0, 20, ['a', 'bc']])
    expect(first('Test/Hood').slice(1)).toEqual([0, 17, [1, 2.5]])
    expect(first('Test/Message').slice(1)).toEqual([0, 4, 'hello'])
    const pose = first('Test/Pose')
    expect(pose[2]).toBe(5)
    expect(pose[3]).toBeInstanceOf(Uint8Array)
    expect((pose[3] as Uint8Array).length).toBe(24)
    // Protobuf (a PhotonVision result) goes as raw bytes, as AdvantageKit publishes it.
    expect(first('Test/Photon').slice(2)).toEqual([5, new Uint8Array([0x20, 0x01])])
  })

  it('skips types NT4 has no equivalent for, and says so', async () => {
    const s = await start()
    expect(s.skipped).toEqual(['/Test/Odd (thing)'])
  })

  it('sends later values in order with the log timestamps, doubles always as float64', async () => {
    const s = await start({ startAt: 0.15 })
    const c = await open(s)
    c.subscribe(1, [`${P}/SystemStats/BatteryVoltage`])
    await until('the log to end', () => c.values.length >= 4, 3000)
    const volts = c.valuesOf(`${P}/SystemStats/BatteryVoltage`)
    expect(volts.map((v) => v[1])).toEqual([100000, 250000, 400000, 500000])
    expect(volts.map((v) => v[3])).toEqual([12.5, 13, 12.25, 12.75])
    expect(volts.every((v) => v[2] === 1)).toBe(true)
  })

  it('puts a whole-number double on the wire as float64 (0xcb)', async () => {
    const s = await start({ startAt: 0 })
    const raw: Buffer[] = []
    const ws = new WebSocket(s.url('raw'), PROTOCOLS)
    ws.on('message', (d, isBinary) => { if (isBinary) raw.push(d as Buffer) })
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify([{ method: 'subscribe', params: { topics: [`${P}/SystemStats/BatteryVoltage`], subuid: 1, options: {} } }]))
    await until('value', () => raw.length > 0)
    ws.terminate()
    // 94, topic id, timestamp 0, type 1, then cb + 8 bytes of 12.0
    const bytes = Array.from(raw[0])
    expect(bytes.filter((_, i) => i !== 1)).toEqual([0x94, 0x00, 0x01, 0xcb, 0x40, 0x28, 0, 0, 0, 0, 0, 0])
  })

  it('does not send values for a topicsonly subscription', async () => {
    const s = await start({ startAt: 0.15 })
    const c = await open(s)
    c.subscribe(1, [`${P}/`], { prefix: true, topicsonly: true })
    await until('announces', () => c.announces.length >= 12 - 1)
    await sleep(200)
    expect(c.values).toEqual([])
  })

  it('stops sending values after unsubscribe', async () => {
    const s = await start({ startAt: 0.15 })
    const c = await open(s)
    c.subscribe(1, [`${P}/SystemStats/BatteryVoltage`])
    await until('first value', () => c.values.length >= 1)
    c.send('unsubscribe', { subuid: 1 })
    const n = c.values.length
    await sleep(700) // the replay reaches 0.85 s: three more records are due
    expect(c.values.length).toBeLessThan(5)
    expect(c.values.length - n).toBeLessThan(3)
    expect(s.received.map((r) => (r.data as { method: string }[])[0].method)).toEqual(['subscribe', 'unsubscribe'])
  })

  it('forces FMSAttached false in pit mode', async () => {
    const s = await start({ pit: true, startAt: 0 })
    const c = await open(s)
    c.subscribe(1, [`${P}/DriverStation/FMSAttached`])
    await until('log end', () => c.valuesOf(`${P}/DriverStation/FMSAttached`).length >= 2)
    await sleep(300)
    expect(c.valuesOf(`${P}/DriverStation/FMSAttached`).map((v) => v[3])).toEqual([false, false])
  })

  it('lets FMSAttached turn true when not in the pit', async () => {
    const s = await start({ startAt: 0 })
    const c = await open(s)
    c.subscribe(1, [`${P}/DriverStation/FMSAttached`])
    await until('true', () => c.valuesOf(`${P}/DriverStation/FMSAttached`).length >= 2)
    expect(c.valuesOf(`${P}/DriverStation/FMSAttached`).map((v) => [v[1], v[3]])).toEqual([[0, false], [200000, true]])
  })

  it('synthesizes /FMSInfo/FMSControlData from the log, outside the prefix', async () => {
    const s = await start({ startAt: 0 })
    const c = await open(s)
    c.subscribe(1, ['/FMSInfo/FMSControlData'])
    await until('3 words', () => c.values.length >= 3)
    expect(c.announces[0]).toMatchObject({ name: '/FMSInfo/FMSControlData', type: 'int' })
    // DS attached (bit 5) at 0; FMS attached (bit 4) at 0.2 s; enabled + auto (bits 0, 1) at 0.3 s
    expect(c.values.map((v) => [v[1], v[2], v[3]])).toEqual([[0, 2, 0b100000], [200000, 2, 0b110000], [300000, 2, 0b110011]])
  })

  it('drops bit 4 of /FMSInfo/FMSControlData in pit mode', async () => {
    const s = await start({ startAt: 0, pit: true })
    const c = await open(s)
    c.subscribe(1, ['/FMSInfo/FMSControlData'])
    await until('2 words', () => c.values.length >= 2)
    expect(c.values.map((v) => v[3])).toEqual([0b100000, 0b100011])
  })

  it('omits /FMSInfo/FMSControlData when asked', async () => {
    const s = await start({ fmsInfo: false })
    const c = await open(s)
    c.subscribe(1, ['/FMSInfo/'], { prefix: true })
    await sleep(100)
    expect(c.announces).toEqual([])
  })

  it('records client frames and answers an RTT ping per the spec', async () => {
    const s = await start({ startAt: 0.15 })
    const c = await open(s)
    const replies: unknown[] = []
    c.ws.on('message', (d, isBinary) => { if (isBinary) replies.push(...decodeMulti(new Uint8Array(d as Buffer))) })
    const { encode } = await import('@msgpack/msgpack')
    c.ws.send(encode([-1, 0, 2, 123456]))
    await until('reply', () => replies.length > 0)
    const [id, serverUs, type, clientTime] = replies[0] as number[]
    expect([id, type, clientTime]).toEqual([-1, 2, 123456])
    expect(serverUs).toBeGreaterThanOrEqual(150000)
    expect(s.received).toHaveLength(1)
    expect(s.received[0]).toMatchObject({ kind: 'binary', data: [[-1, 0, 2, 123456]] })
  })

  it('negotiates the 4.1 subprotocol, or 4.0 when that is all the client offers', async () => {
    const s = await start()
    for (const [offered, expected] of [[PROTOCOLS, PROTOCOLS[0]], [[PROTOCOLS[1]], PROTOCOLS[1]], [[PROTOCOLS[1], PROTOCOLS[0]], PROTOCOLS[0]]]) {
      const ws = new WebSocket(s.url('p'), offered)
      await new Promise((r) => ws.on('open', r))
      expect(ws.protocol).toBe(expected)
      ws.terminate()
    }
  })

  it('rejects a path other than /nt/<name>, and a client with no common subprotocol', async () => {
    const s = await start()
    const bad = (url: string, protocols: string[]) => new Promise<number | string>((resolve) => {
      const ws = new WebSocket(url, protocols)
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => { ws.terminate(); resolve('opened') })
      ws.on('error', () => undefined)
    })
    expect(await bad(`ws://127.0.0.1:${s.port}/bad`, PROTOCOLS)).toBe(404)
    expect(await bad(`ws://127.0.0.1:${s.port}/nt/`, PROTOCOLS)).toBe(404)
    expect(await bad(`ws://127.0.0.1:${s.port}/nt/x`, ['mqtt'])).toBe(400)
  })

  it('keeps the connection open after the log ends', async () => {
    const s = await start({ startAt: 0.4, speed: 4 })
    const c = await open(s)
    c.subscribe(1, [`${P}/SystemStats/BatteryVoltage`])
    await until('log end', () => c.values.length >= 2)
    await sleep(100)
    expect(c.ws.readyState).toBe(WebSocket.OPEN)
    expect(s.now()).toBeGreaterThan(0.5)
  })
})

const CALGAMES = `${homedir()}/Downloads/akit_26-10-17_21-24-40_cacg_q21.wpilog`

describe('NT4 replay server on the CalGames Q21 log', () => {
  if (!existsSync(CALGAMES)) {
    it.skip(`needs ${CALGAMES}, which is not on this machine`, () => undefined)
    return
  }
  it('turns FMSAttached true at 27.7-27.8 s and holds the battery near 12.5 V', async () => {
    server = await startReplayServer({ bytes: readFileSync(CALGAMES), speed: 50 })
    const c = await open(server)
    const fms = `${P}/DriverStation/FMSAttached`
    const battery = `${P}/SystemStats/BatteryVoltage`
    c.subscribe(1, [fms, battery])
    await until('robot time 28 s', () => server!.now() >= 28, 5000)
    await sleep(100)
    const attached = c.valuesOf(fms).find((v) => v[3] === true)!
    expect(attached[1] / 1e6).toBeGreaterThanOrEqual(27.7)
    expect(attached[1] / 1e6).toBeLessThanOrEqual(27.8)
    const volts = c.valuesOf(battery).filter((v) => v[1] / 1e6 < 27.8).map((v) => v[3] as number)
    expect(volts.length).toBeGreaterThan(100)
    expect(Math.min(...volts)).toBeGreaterThanOrEqual(12.4)
    expect(Math.max(...volts)).toBeLessThanOrEqual(12.7)
  }, 15000)

  it('in pit mode never reports FMSAttached true', async () => {
    server = await startReplayServer({ bytes: readFileSync(CALGAMES), speed: 50, pit: true })
    const c = await open(server)
    const fms = `${P}/DriverStation/FMSAttached`
    c.subscribe(1, [fms, '/FMSInfo/FMSControlData'])
    await until('robot time 28 s', () => server!.now() >= 28, 5000)
    await sleep(100)
    expect(c.valuesOf(fms).map((v) => v[3])).not.toContain(true)
    expect(c.valuesOf('/FMSInfo/FMSControlData').every((v) => ((v[3] as number) & 0x10) === 0)).toBe(true)
  }, 15000)
})
