/**
 * Reading .hoot files through owlet (ADR 13), with a fake owlet and a made-up CTRE index: never CTRE's binaries, its real
 * index or a real .hoot.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { align, edgesOf } from '../src/hoot/align.ts'
import { binned, gapsIn, onOff } from '../src/hoot/reduce.ts'
import { busOf, compliancyOf, findOwlet, parseScan, pickDownload, platformKey, runOutcome, sha1Of, wantedIds } from '../src/hoot/owlet.ts'
import { readHoot } from '../src/hoot/read-hoot.ts'
import { downloadOwlet } from '../src/hoot/download.ts'
import { deviceRows, enabledSpans, profileNames } from '../src/hoot/view.ts'
import type { HootDevice, HootReading } from '../src/hoot/types.ts'
import { fakeHootBytes, fakeOwletArgv, type FakeHoot } from './helpers/fake-owlet.ts'

const series = (t: number[], v: number[]) => ({ name: 'x', t: Float64Array.from(t), v: Float64Array.from(v) })

describe('lining a .hoot up with its robot log', () => {
  // The shape measured on a real pair: ten edges each, the log 11.60-11.70 s later.
  const hoot = edgesOf([{ t: 0.4, on: false }, { t: 13.777, on: true }, { t: 40.313, on: false }, { t: 246.085, on: true }, { t: 261.523, on: false }, { t: 385.0, on: true }, { t: 386.532, on: false }])
  const log = edgesOf([{ t: 17.1, on: false }, { t: 25.474, on: true }, { t: 51.916, on: false }, { t: 257.732, on: true }, { t: 273.131, on: false }, { t: 396.65, on: true }, { t: 398.156, on: false }])

  it('finds the offset from the enable edges and says how well they agree', () => {
    const a = align(hoot, log)
    expect(a.offset).not.toBeNull()
    if (a.offset === null) return
    expect(a.offset).toBeGreaterThan(11.6)
    expect(a.offset).toBeLessThan(11.7)
    expect(a.matched).toBe(6)
    expect(a.spread).toBeLessThan(0.1)
  })

  it('does not line up files whose edges never agree', () => {
    const a = align(hoot, [{ t: 100, on: true }, { t: 107, on: false }])
    expect(a).toEqual({ offset: null, why: expect.stringContaining("don't line up") })
  })

  it('says why when either file never saw the robot enabled, or the .hoot was enabled throughout', () => {
    expect(align([], log, true)).toEqual({ offset: null, why: expect.stringContaining('from the start of the .hoot') })
    expect(align([], log)).toEqual({ offset: null, why: expect.stringContaining('.hoot never') })
    expect(align(hoot, [])).toEqual({ offset: null, why: expect.stringContaining('robot log never') })
  })

  it('never lines files up on one edge', () => {
    expect(align([{ t: 5, on: true }], [{ t: 16.6, on: true }])).toEqual({ offset: null, why: expect.stringContaining('too few') })
  })

  it('does not take two or three chance agreements with the wrong log', () => {
    // A wrong log of the same session: 2 of its 10 edges happen to sit 118 s from two of the .hoot's 20.
    const many = Array.from({ length: 20 }, (_, i) => ({ t: 10 + i * 30 + (i % 2) * 7, on: i % 2 === 0 }))
    const wrong = [{ t: 128, on: true }, { t: 135, on: false }, ...Array.from({ length: 8 }, (_, i) => ({ t: 400 + i * 41, on: i % 2 === 0 }))]
    expect(align(many, wrong)).toMatchObject({ offset: null })
  })
})

describe('reducing owlet\'s export', () => {
  it('keeps the lowest voltage and the highest current of each bin', () => {
    const b = binned([{ s: series([0.01, 0.1, 0.2, 0.3], [12, 6.5, 11, 12.2]), keep: Math.min }, { s: series([0.05, 0.15], [10, 80]), keep: Math.max }], 0.25)
    expect(b.t).toEqual([0, 0.25])
    expect(b.values[0]).toEqual([6.5, 12.2])
    expect(b.values[1]).toEqual([80, NaN])
  })

  it('turns a fault into on and off times', () => {
    expect(onOff(series([2.596, 385.125, 385.379, 400], [0, 1, 0, 0]))).toEqual([{ on: 385.125, off: 385.379 }])
    expect(onOff(series([0, 5], [0, 1]))).toEqual([{ on: 5, off: null }])
  })

  it('marks a device gone silent, but not a slow signal', () => {
    const t = Array.from({ length: 100 }, (_, i) => i * 0.02)
    expect(gapsIn([...t, 5, 5.02], 0, 5.02)).toEqual([{ from: 1.98, to: 5 }])
    expect(gapsIn([0, 1, 2, 3, 4], 0, 4)).toEqual([])
  })
})

describe('owlet', () => {
  it('reads the format byte at offset 70', () => {
    const b = new Uint8Array(80)
    b[70] = 19
    expect(compliancyOf(b)).toBe(19)
    expect(compliancyOf(new Uint8Array(70))).toBeNull()
  })

  it('takes Hindsight\'s own folder first, then the highest version that reads this format', () => {
    const files: Record<string, string[]> = { own: ['owlet-26.1.0-C19', 'owlet-25.4.1-C13'], ascope: ['owlet-26.3.0-C19', 'owlet-26.70.0-C21', 'notes.txt'] }
    const folders = [{ dir: 'own', where: 'hindsight' as const }, { dir: 'ascope', where: 'advantagescope' as const }]
    expect(findOwlet(19, folders, (d) => files[d] ?? [])).toMatchObject({ version: '26.1.0', where: 'hindsight' })
    expect(findOwlet(21, folders, (d) => files[d] ?? [])).toMatchObject({ version: '26.70.0', where: 'advantagescope' })
    expect(findOwlet(9, folders, (d) => files[d] ?? [])).toBeNull()
  })

  it('maps this computer to CTRE\'s build names as AdvantageScope does', () => {
    expect(platformKey('darwin', 'arm64')).toBe('macosuniversal')
    expect(platformKey('win32', 'arm64')).toBe('windowsx86-64')
    expect(platformKey('linux', 'arm64')).toBe('linuxarm64')
    expect(platformKey('linux', 'ia32')).toBeNull()
  })

  const index = { JsonVersion: '1.0.0.0', Tools: [{ Name: 'owlet', Items: [
    { Version: '26.1.0', Compliancy: 19, Urls: { macosuniversal: 'https://redist.ctr-electronics.com/tools/owlet/26.1.0/o', 'macosuniversal-sha1': 'a'.repeat(40) } },
    { Version: '26.3.0', Compliancy: 19, Urls: { macosuniversal: 'https://redist.ctr-electronics.com/tools/owlet/26.3.0/o', 'macosuniversal-sha1': 'b'.repeat(40) } },
    { Version: '26.70.0', Compliancy: 21, Urls: { macosuniversal: 'https://redist.ctr-electronics.com/tools/owlet/26.70.0/o', 'macosuniversal-sha1': 'c'.repeat(40) } },
    { Version: '27.0.0', Compliancy: 19, Urls: { macosuniversal: 'https://elsewhere.example.com/o', 'macosuniversal-sha1': 'd'.repeat(40) } },
  ] }] }

  it('picks the newest build for the file\'s format, never the latest channel, and only from CTRE\'s server', () => {
    expect(pickDownload(index, 19, 'macosuniversal')).toMatchObject({ version: '26.3.0', sha1: 'b'.repeat(40) })
    expect(pickDownload(index, 13, 'macosuniversal')).toEqual({ problem: expect.stringContaining('format 13') })
    expect(pickDownload(index, 19, 'linuxx86-64')).toEqual({ problem: expect.any(String) })
    expect(pickDownload({}, 19, 'macosuniversal')).toEqual({ problem: expect.stringContaining('no owlet') })
  })

  it('reads a scan by name, skipping owlet\'s own lines', () => {
    const s = parseScan('Could not read to end of input file: Bad message\nRobotEnable:        1ff00\nTalonFX-11/SupplyVoltage:   6f50b00\nTalonFX-11/Fault_BridgeBrownout: 27140b00\nTalonFX-11/Fault_ForwardSoftLimit: 27170b00\n')
    expect(s.cutShort).toContain('Bad message')
    expect(wantedIds(s.ids).sort()).toEqual(['1ff00', '27140b00', '6f50b00'])
  })

  it('names the bus from the file name, prefix or not', () => {
    expect(busOf('ABC123_2026-03-14_20-14-20.hoot')).toBe('ABC123')
    expect(busOf('_Q7_rio_2025-03-01_14-38-23.hoot')).toBe('rio')
  })

  it('counts exit 1 with the cut-short line and an output as read', () => {
    expect(runOutcome({ code: 1, out: 'Could not read to end of input file: Bad message', err: '' }, true)).toEqual({ ok: true, cutShort: expect.stringContaining('Bad message') })
    expect(runOutcome({ code: 1, out: 'Could not read to end of input file: Bad message', err: '' }, false)).toMatchObject({ ok: false })
    expect(runOutcome({ code: 2, out: '', err: 'License check failed' }, true)).toEqual({ ok: false, why: expect.stringContaining('License check failed') })
  })
})

describe('reading a .hoot through (a fake) owlet', () => {
  const brownout: FakeHoot = {
    compliancy: 19,
    signals: {
      RobotEnable: { type: 'boolean', t: [0.4, 13.777, 40.313], v: [false, true, false] },
      'TalonFX-11/SupplyVoltage': { type: 'double', t: [1, 20, 20.1, 30], v: [12.5, 11.9, 6.9, 12.1] },
      'TalonFX-11/SupplyCurrent': { type: 'double', t: [1, 20.05], v: [0, 85] },
      'TalonFX-11/DeviceTemp': { type: 'double', t: [1, 30], v: [25, 31] },
      'TalonFX-11/Fault_BridgeBrownout': { type: 'boolean', t: [1, 20.1, 20.35], v: [false, true, false] },
      'TalonFX-11/Fault_ForwardSoftLimit': { type: 'boolean', t: [1, 25], v: [false, true] },
      'TalonFX-11/RotorVelocity': { type: 'double', t: [1], v: [0] },
    },
    automatic: { 'TalonFX-11/ResetCount': { type: 'int64', t: [1, 22], v: [3, 4] } },
  }
  async function setUp(h: FakeHoot) {
    const dir = await mkdtemp(join(tmpdir(), 'hoot-test-'))
    const hootPath = join(dir, 'ABC_2026-03-14_20-14-20.hoot')
    await writeFile(hootPath, fakeHootBytes(h))
    const owlet = { path: 'fake', version: '26.3.0', compliancy: 19, where: 'hindsight' as const }
    return { dir, opts: { owlet, argv: fakeOwletArgv(), hootPath, fileName: 'ABC_2026-03-14_20-14-20.hoot', sha256: 'f'.repeat(64), cacheDir: join(dir, 'cache'), tempRoot: dir } }
  }

  it('reads only the wanted signals, keeps the fault and the restart, and caches the result', async () => {
    const { dir, opts } = await setUp(brownout)
    const r = await readHoot(opts)
    expect(r.cached).toBe(false)
    expect(r.bus).toBe('ABC')
    expect(r.enable.map((e) => e.on)).toEqual([false, true, false])
    const fx = r.devices.find((d) => d.name === 'TalonFX-11')!
    expect(fx.faults).toEqual([{ name: 'BridgeBrownout', on: 20.1, off: 20.35 }])
    expect(fx.resets).toEqual([22])
    expect(Math.min(...fx.volts!.filter(Number.isFinite))).toBe(6.9)
    expect(Math.max(...fx.amps!.filter(Number.isFinite))).toBe(85)
    expect(fx.temp!.c).toContain(31)
    expect((await readHoot(opts)).cached).toBe(true)
    // owlet's export was removed; only the cache remains.
    expect((await readdir(dir)).sort()).toEqual(['ABC_2026-03-14_20-14-20.hoot', 'cache'])
  }, 20_000)

  it('reads a file that ends early and says so', async () => {
    const { opts } = await setUp({ ...brownout, cutShort: true })
    const r = await readHoot(opts)
    expect(r.cutShort).toContain('Could not read to end of input file')
    expect(r.devices).toHaveLength(1)
  }, 20_000)

  it('stops an owlet that stalls and says where', async () => {
    const { opts } = await setUp({ ...brownout, stuckAt40: true })
    await expect(readHoot({ ...opts, stallMs: 600 })).rejects.toThrow(/stopped making progress at 40% of ABC_2026-03-14_20-14-20\.hoot/)
  }, 20_000)

  it('stops a scan that never answers', async () => {
    const { opts } = await setUp({ ...brownout, hang: 'scan' })
    await expect(readHoot({ ...opts, scanDeadlineMs: 600 })).rejects.toThrow(/no answer for ABC_2026-03-14_20-14-20\.hoot within 1 s/)
  }, 20_000)

  it('passes owlet\'s own words on when it fails', async () => {
    const { opts } = await setUp({ ...brownout, fail: { code: 3, message: 'License check failed' } })
    await expect(readHoot(opts)).rejects.toThrow(/owlet exited with 3: License check failed/)
  }, 20_000)
})

describe('downloading owlet from CTRE', () => {
  const body = new TextEncoder().encode('#!/bin/sh\necho not really owlet\n')
  const index = (sha1: string) => ({ JsonVersion: '1.0.0.0', Tools: [{ Name: 'owlet', Items: [{ Version: '26.3.0', Compliancy: 19, Urls: { macosuniversal: 'https://redist.ctr-electronics.com/tools/owlet/26.3.0/owlet-26.3.0-macosuniversal', 'macosuniversal-sha1': sha1 } }] }] })
  const fakeFetch = (sha1: string, stall = false) => (async (url: string | URL) => {
    if (String(url).endsWith('index.json')) return new Response(JSON.stringify(index(sha1)))
    if (stall) return new Response(new ReadableStream({ start() {} }))
    return new Response(body, { headers: { 'content-length': String(body.length) } })
  }) as typeof fetch

  it('saves a build whose sha-1 matches, executable, under owlet\'s usual name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlet-dl-'))
    const seen: number[] = []
    const got = await downloadOwlet({ compliancy: 19, platform: 'darwin', arch: 'arm64', dir, fetch: fakeFetch(sha1Of(body)), onBytes: (d) => seen.push(d) })
    expect(got).toMatchObject({ version: '26.3.0', compliancy: 19, where: 'hindsight' })
    expect(await readdir(dir)).toEqual(['owlet-26.3.0-C19'])
    expect(seen.at(-1)).toBe(body.length)
  })

  it('saves nothing when the checksum does not match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlet-dl-'))
    await expect(downloadOwlet({ compliancy: 19, platform: 'darwin', arch: 'arm64', dir, fetch: fakeFetch('0'.repeat(40)) })).rejects.toThrow(/does not match CTRE's checksum/)
    expect(await readdir(dir).catch(() => [])).toEqual([])
  })

  it('names a stalled download in words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlet-dl-'))
    await expect(downloadOwlet({ compliancy: 19, platform: 'darwin', arch: 'arm64', dir, fetch: fakeFetch(sha1Of(body), true), stallMs: 300 })).rejects.toThrow(/nothing arrived for 0 s/)
  })

  it('says when CTRE has no build for this computer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlet-dl-'))
    await expect(downloadOwlet({ compliancy: 19, platform: 'linux', arch: 'x64', dir, fetch: fakeFetch(sha1Of(body)) })).rejects.toThrow(/no owlet for this computer/)
  })
})

describe('the Devices tab\'s rows', () => {
  const device = (name: string, over: Partial<HootDevice> = {}): HootDevice => ({ name, t: [0, 1, 2, 3], volts: [12, 11, 7, 12], amps: [0, 10, 80, 0], temp: { t: [0, 3], c: [25, 40] }, gaps: [], faults: [], resets: [], ...over })
  const reading = (devices: HootDevice[]): HootReading => ({ file: 'ABC_2026-03-14_20-14-20.hoot', bus: 'ABC', start: 0, end: 4, enable: [{ t: 0, on: false }, { t: 1.5, on: true }, { t: 3.5, on: false }], devices, cutShort: null, owlet: '26.3.0-C19' })

  it('takes the lowest voltage and peak current while enabled on the .hoot\'s own clock, temperature over the file', () => {
    const [row] = deviceRows(reading([device('TalonFX-1')]), new Map())
    expect(enabledSpans(reading([]))).toEqual([{ start: 1.5, end: 3.5 }])
    expect(row).toMatchObject({ lowestVolts: 7, peakAmps: 80, peakTemp: 40, label: 'TalonFX-1' })
  })

  it('puts devices with a fault or restart first, earliest first, then the lowest voltage', () => {
    const rows = deviceRows(reading([
      device('TalonFX-1'), device('TalonFX-2', { volts: [12, 12, 6.5, 12] }),
      device('TalonFX-3', { resets: [3] }), device('TalonFX-4', { faults: [{ name: 'BridgeBrownout', on: 2, off: 2.25 }] }),
    ]), new Map())
    expect(rows.map((r) => r.device.name)).toEqual(['TalonFX-4', 'TalonFX-3', 'TalonFX-2', 'TalonFX-1'])
    expect(rows[0].events).toEqual([{ t: 2, what: 'BridgeBrownout' }])
  })

  it('names a motor from the profile only when its CAN id is unique in the profile and on one .hoot', () => {
    const profile = { motorGroups: [{ name: 'Shooter', motors: [{ name: 'Flywheel leader', canId: 12 }, { name: 'Hood', canId: 11 }, { name: 'Other hood', canId: 11 }] }], foresight: undefined } as unknown as Parameters<typeof profileNames>[0]
    const one = reading([device('TalonFX-12'), device('TalonFX-11')])
    expect([...profileNames(profile, [one])[0]]).toEqual([['TalonFX-12', 'Flywheel leader']])
    // A second bus with its own TalonFX-12: the profile names no bus, so neither is named.
    expect(profileNames(profile, [one, reading([device('TalonFX-12')])])[0].size).toBe(0)
  })
})
