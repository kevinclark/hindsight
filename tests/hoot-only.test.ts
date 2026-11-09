/**
 * Slice 1 of the .hoot work: a robot that logs only .hoot (ADR 13). Invented data and a fake owlet throughout: never CTRE's
 * binaries or a real .hoot. A hoot-only log runs no rule (Kevin's decision 5); these tests hold that, and the places a
 * .hoot-only entry must never reach (`entries()`, the Session view, another match's `others`).
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeFiles } from '../src/analyze.ts'
import { parseScan, wantedIds } from '../src/hoot/owlet.ts'
import { readHoot } from '../src/hoot/read-hoot.ts'
import { hootWpilog } from '../src/hoot/synthetic.ts'
import { hootOwnNotes } from '../src/hoot/view.ts'
import type { HootReading } from '../src/hoot/types.ts'
import { Catalog } from '../src/hub/catalog.ts'
import { serializeRecord, type LogRecord } from '../src/hub/types.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { formatOf, LOG_FORMATS } from '../src/profiles/formats.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { encodePayload, writeRecords } from '../src/readers/wpilog-writer.ts'
import { RULES } from '../src/rules/index.ts'
import { HOOT_NOT_IN_SESSIONS, summarizeLog } from '../src/session/summary.ts'
import { reviewCard, reviewModel } from '../src/report/review-model.ts'
import { fakeHootBytes, fakeOwletArgv, type FakeHoot } from './helpers/fake-owlet.ts'

const REASON = "rules don't read .hoot data yet"

describe('reading a scan with colons in the names', () => {
  it("reads DS:IsFMSAttached and RobotMode, which the old pattern dropped, and still skips owlet's own lines", () => {
    const s = parseScan([
      'Could not read to end of input file: Bad message',
      'RobotEnable:   1ff00', 'DS:IsDSAttached:   2ff00', 'DS:IsFMSAttached:   3ff00', 'RobotMode:   4ff00',
      'TalonFX-11/SupplyVoltage:   6f50b00', 'Progress: [ 50%] done', ''].join('\n'))
    expect(s.cutShort).toContain('Bad message')
    expect(s.ids.get('DS:IsFMSAttached')).toBe('3ff00')
    expect(wantedIds(s.ids).sort()).toEqual(['1ff00', '3ff00', '4ff00', '6f50b00'])
  })
})

describe('reducing a .hoot with mode, FMS and two Talons', () => {
  const every002 = Array.from({ length: 201 }, (_, i) => i * 0.02)
  const hoot = (over: Partial<FakeHoot['signals']> = {}): FakeHoot => ({
    compliancy: 19,
    signals: {
      RobotEnable: { type: 'boolean', t: [0, 1, 3], v: [false, true, false] },
      RobotMode: { type: 'string', t: [0, 0.5, 1, 2], v: ['Disabled', 'Disabled', 'Autonomous', 'Teleop'] },
      'DS:IsFMSAttached': { type: 'boolean', t: [0, 2], v: [false, true] },
      // Talon 11 reports every 0.02 s all through; Talon 12 starts at 1.01 and goes silent from 1.05 to 3.01.
      'TalonFX-11/SupplyCurrent': { type: 'double', t: every002, v: every002.map(() => 10) },
      'TalonFX-12/SupplyCurrent': { type: 'double', t: [1.01, 1.03, 1.05, 3.01], v: [5, 5, 5, 7] },
      ...over,
    },
  })
  async function read(h: FakeHoot): Promise<HootReading> {
    const dir = await mkdtemp(join(tmpdir(), 'hoot-only-'))
    const hootPath = join(dir, 'ABC_2026-03-14_20-14-20.hoot')
    await writeFile(hootPath, fakeHootBytes(h))
    return readHoot({ owlet: { path: 'fake', version: '26.3.0', compliancy: 19, where: 'hindsight' }, argv: fakeOwletArgv(), hootPath, fileName: 'ABC_2026-03-14_20-14-20.hoot', sha256: 'e'.repeat(64), cacheDir: join(dir, 'cache'), tempRoot: dir })
  }

  it('keeps each change of the mode and of FMS, and sums the Talons on the 0.02 s grid', async () => {
    const r = await read(hoot())
    expect(r.mode).toEqual([{ t: 0, v: 'Disabled' }, { t: 1, v: 'Autonomous' }, { t: 2, v: 'Teleop' }])
    expect(r.fms).toEqual([{ t: 0, on: false }, { t: 2, on: true }])
    const at = (t: number) => r.totalAmps.a[Math.round(t / 0.02)]
    expect(r.totalAmps.t[0]).toBe(0)
    expect(r.totalAmps.t[1]).toBe(0.02)
    expect(at(0.2)).toBe(10) // Talon 12 has no record yet: 0 A
    expect(at(1.04)).toBe(15) // both reporting
    expect(at(1.5)).toBe(10) // Talon 12 inside its gap: 0 A, not its last 5 A held
    expect(Math.max(...r.totalAmps.a)).toBe(15)
  }, 20_000)

  it('leaves mode and FMS empty when the .hoot has neither', async () => {
    const h = hoot()
    delete h.signals.RobotMode
    delete h.signals['DS:IsFMSAttached']
    const r = await read(h)
    expect(r.mode).toEqual([])
    expect(r.fms).toEqual([])
  }, 20_000)

  it('end to end (what hub:hootLog does): the synthetic log opens as one run, auto first, practice, no rule read', async () => {
    const r = await read(hoot({ 'DS:IsFMSAttached': { type: 'boolean', t: [0], v: [false] } }))
    const { analyses } = analyzeFiles([{ name: 'ABC_2026-03-14_20-14-20.hoot', bytes: hootWpilog(r) }])
    const a = analyses[0]
    expect(formatOf(a.match.log)?.name).toBe('Phoenix hoot')
    expect(a.match.fms).toBe(false)
    expect(a.match.matchStart).toBeCloseTo(1, 1)
    expect(a.match.auto[0].start).toBeCloseTo(1, 1)
    expect(a.report.noRules).toBe(REASON)
  }, 20_000)
})

const reading = (over: Partial<HootReading> = {}): HootReading => ({
  file: 'ABC_2026-03-14_20-14-20.hoot', bus: 'ABC', start: 0, end: 30,
  enable: [{ t: 0, on: false }, { t: 5, on: true }, { t: 25, on: false }],
  mode: [{ t: 0, v: 'Disabled' }, { t: 5, v: 'Autonomous' }, { t: 20, v: 'Teleop' }],
  fms: [], totalAmps: { t: Array.from({ length: 1500 }, (_, i) => i * 0.02), a: Array.from({ length: 1500 }, () => 12.5) },
  devices: [], cutShort: null, owlet: '26.3.0-C19', ...over,
})

describe('the synthetic log and the "Phoenix hoot" format', () => {
  it('round-trips through the reader: practice, a run from RobotEnable, the run that starts in Autonomous is auto', () => {
    const log = openWpilog(hootWpilog(reading()))
    expect(log.firstTime).toBe(0)
    expect(log.lastTime).toBe(30)
    const { analyses } = analyzeFiles([{ name: 'ABC_2026-03-14_20-14-20.hoot', bytes: hootWpilog(reading()) }])
    const m = analyses[0].match
    expect(m.fms).toBe(false)
    // Enabled from 5 s to 25 s; the mode change at 20 s splits it into the auto and teleop periods, one run.
    expect(m.enabled[0].start).toBeCloseTo(5, 3)
    expect(m.enabled.at(-1)!.end).toBeCloseTo(25, 3)
    expect(m.runs).toHaveLength(1)
    expect(m.runs[0]).toMatchObject({ auto: true })
    expect(m.auto[0].start).toBeCloseTo(5, 3)
    expect(m.profile.signals.fmsAttached).toBe('')
  })

  it('writes DS:IsFMSAttached only when the reading has one', () => {
    expect(openWpilog(hootWpilog(reading())).entries.has('DS:IsFMSAttached')).toBe(false)
    expect(openWpilog(hootWpilog(reading({ fms: [{ t: 0, on: false }] }))).entries.has('DS:IsFMSAttached')).toBe(true)
  })

  const entryOf = (...names: string[]) => writeRecords(names.map((name) => ({ name, type: 'boolean', t: [0, 1], payload: [encodePayload('boolean', false)!, encodePayload('boolean', true)!] })))
  it('is picked only when no other marker is present: AdvantageKit with a RobotEnable is still AdvantageKit', () => {
    expect(LOG_FORMATS.at(-1)?.name).toBe('Phoenix hoot')
    expect(formatOf(openWpilog(entryOf('RobotEnable')))?.name).toBe('Phoenix hoot')
    expect(formatOf(openWpilog(entryOf('/DriverStation/Enabled', 'RobotEnable')))?.name).toBe('AdvantageKit')
    expect(formatOf(openWpilog(entryOf('DS:enabled', 'RobotEnable')))?.name).toBe('WPILib DataLogManager')
  })

  it('runs no rule: no finding but the plain not-checked one, every rule skipped with the reason', () => {
    const { analyses } = analyzeFiles([{ name: 'x.hoot', bytes: hootWpilog(reading()) }])
    const r = analyses[0].report
    expect(r.noRules).toBe(REASON)
    expect(r.findings.map((f) => f.rule)).toEqual(['meta/not-checked'])
    expect(r.findings[0].title).toBe(`No rule read this log: ${REASON}`)
    expect(r.findings[0].nextStep).toBe("The Devices tab shows each CTRE device's voltage, current, temperature and faults.")
    expect(r.skipped).toHaveLength(RULES.length)
    expect(new Set(r.skipped.map((s) => s.reason))).toEqual(new Set([REASON]))
    expect(r.crashed).toEqual([])
    expect(r.parents).toBeUndefined()
  })

  it('says so in the report and the Slack card instead of "nothing to fix"', () => {
    const { analyses } = analyzeFiles([{ name: 'x.hoot', bytes: hootWpilog(reading()) }])
    const model = reviewModel(analyses[0], new Map())
    expect(model.noRules).toBe(REASON)
    expect(reviewCard(model).emptyText).toBe(`No rule read this log: ${REASON}.`)
  })

  it('is no other match\'s neighbour, and has none', () => {
    const akit = writeRecords([{ name: '/DriverStation/Enabled', type: 'boolean', t: [0, 5, 20, 30], payload: [false, true, false, false].map((b) => encodePayload('boolean', b)!) }])
    const { analyses } = analyzeFiles([{ name: 'a.hoot', bytes: hootWpilog(reading()) }, { name: 'b.wpilog', bytes: akit }, { name: 'c.wpilog', bytes: akit }])
    const by = (n: string) => analyses.find((a) => a.match.fileName === n)!.match
    expect(by('a.hoot').others).toEqual([])
    expect(by('b.wpilog').others.map((o) => o.fileName)).toEqual(['c.wpilog'])
    expect(by('c.wpilog').others.map((o) => o.fileName)).toEqual(['b.wpilog'])
  })
})

describe('choosing the profile for a log made from a .hoot', () => {
  const log = (r: HootReading) => openWpilog(hootWpilog(r))
  it('reads with the format\'s signals and says what it is, never "Add a profile for this robot"', () => {
    const { profile, choice } = chooseProfile(log(reading()), PROFILES)
    expect(profile.signals.enabled).toBe('RobotEnable')
    expect(profile.signals.totalCurrent).toBe('Phoenix6/TotalSupplyCurrent')
    expect(profile.motorGroups).toEqual([])
    expect(choice.note).toBe('Read as a Phoenix .hoot: no rule reads it yet; the Devices tab shows each device.')
    expect(choice.note).not.toContain('Add a profile')
  })

  it('keeps a chosen robot\'s motors (the Devices tab names devices with them) but not its AdvantageKit keys', () => {
    const chosen = PROFILES.find((p) => p.motorGroups.length > 0)!
    const { profile, choice } = chooseProfile(log(reading()), PROFILES, chosen)
    expect(profile.motorGroups).toEqual(chosen.motorGroups)
    expect(profile.signals.enabled).toBe('RobotEnable')
    expect(profile.signals.batteryVoltage).toBe('')
    expect(choice.how).toBe('chosen by you')
    expect(choice.note).toContain('Read as a Phoenix .hoot')
  })

  it('adds the FMS note when the .hoot says FMS was attached at any record, and not when it never did', () => {
    const on = chooseProfile(log(reading({ fms: [{ t: 0, on: false }, { t: 9, on: true }] })), PROFILES).choice.note
    expect(on).toContain('This .hoot says a field (FMS) was attached at some point.')
    expect(on).toContain('this log is read as practice: every run counts.')
    const off = chooseProfile(log(reading({ fms: [{ t: 0, on: false }] })), PROFILES).choice.note
    expect(off).not.toContain('FMS')
  })

  it('reads a log that says FMS was attached as practice all the same', () => {
    const { analyses } = analyzeFiles([{ name: 'x.hoot', bytes: hootWpilog(reading({ fms: [{ t: 0, on: true }] })) }])
    expect(analyses[0].match.fms).toBe(false)
  })
})

describe('the Session view refuses a log made from a .hoot at its pure layer', () => {
  it('makes no summary and says where to open it', () => {
    expect(() => summarizeLog({ name: 'ABC_2026-03-14_20-14-20.hoot', bytes: hootWpilog(reading()) })).toThrow(HOOT_NOT_IN_SESSIONS)
    expect(HOOT_NOT_IN_SESSIONS).toBe("read from a .hoot: open it in Match review. Sessions don't read .hoot data yet.")
  })
})

describe('Catalog.hootOnly: the .hoot files no robot log took', () => {
  const utc = (h: number, mi: number, s: number) => Date.UTC(2026, 2, 14, h, mi, s)
  const rec = (over: Partial<LogRecord> & { sha256: string }): LogRecord => ({
    type: 'log', kind: 'hoot', playedAt: utc(20, 14, 20), dateSource: 'file name', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
    onField: false, batteryId: null, roboRio: null, edition: null, robot: null, build: null, stub: false, hardwareId: null,
    size: 1, path: `logs/x/${over.sha256}.hoot`, names: [`${over.sha256}.hoot`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm1', ...over,
  })
  const robot = rec({ sha256: 'r1', kind: 'wpilog', path: 'logs/x/akit_26-03-14_20-14-30.wpilog', names: ['akit_26-03-14_20-14-30.wpilog'], playedAt: utc(20, 14, 30), dateSource: 'robot clock', wall: { start: utc(20, 14, 30), end: utc(20, 24, 30) } })
  const hoot = (sha256: string, name: string, size: number, playedAt: number | null = utc(20, 14, 20)) => rec({ sha256, path: `logs/x/${name}`, names: [name], size, playedAt })
  const catalog = (records: LogRecord[]) => Catalog.from([records.map(serializeRecord).join('')])

  it('groups a CANivore .hoot and its roboRIO twin by name time: the largest is the record, the other is attached', () => {
    const c = catalog([hoot('h1', 'ABC_2026-03-14_20-14-20.hoot', 5000), hoot('h2', 'rio_2026-03-14_20-14-20.hoot', 40), hoot('h3', 'ABC_2026-03-14_21-30-00.hoot', 70, utc(21, 30, 0))])
    const only = c.hootOnly()
    expect(only).toHaveLength(2)
    expect(only[0].record.sha256).toBe('h1')
    expect(only[0].attached.hoot.map((r) => r.sha256)).toEqual(['h2'])
    expect(only[0].attached.dslog).toEqual([])
    expect(only[1].record.sha256).toBe('h3')
    expect(only[1].attached.hoot).toEqual([])
  })

  it('never lists a .hoot a robot log took, and leaves entries() exactly as it was', () => {
    const records = [robot, hoot('h1', 'ABC_2026-03-14_20-14-20.hoot', 5000), hoot('h9', 'ZZZ_2026-03-14_23-59-00.hoot', 9, utc(23, 59, 0))]
    const c = catalog(records)
    const entries = c.entries()
    expect(entries.map((e) => e.record.sha256)).toEqual(['r1'])
    expect(entries[0].attached.hoot.map((r) => r.sha256)).toEqual(['h1'])
    expect(c.hootOnly().map((e) => e.record.sha256)).toEqual(['h9'])
    // The same entries with and without the hoot-only file in the library.
    expect(JSON.stringify(catalog(records.slice(0, 2)).entries())).toBe(JSON.stringify(entries))
  })

  it('lists an undated .hoot, each name with no time as its own group, and never stitches different times', () => {
    const c = catalog([hoot('u1', 'mystery.hoot', 3, null), hoot('u2', 'other.hoot', 2, null), hoot('t1', 'ABC_2026-03-14_20-14-20.hoot', 9), hoot('t2', 'ABC_2026-03-14_20-14-21.hoot', 9)])
    expect(c.hootOnly().map((e) => e.record.sha256).sort()).toEqual(['t1', 't2', 'u1', 'u2'])
    expect(c.hootOnly().every((e) => e.attached.hoot.length === 0)).toBe(true)
  })
})

describe('the Devices tab on a log that is itself a .hoot', () => {
  const r = { file: 'ABC_2026-03-14_20-14-20.hoot', bus: 'ABC', end: 100 }
  it('says it is the .hoot itself, for files with the same name time', () => {
    expect(hootOwnNotes(r, 'ABC_2026-03-14_20-14-20.hoot', [])).toEqual(['This log is the .hoot itself.'])
    expect(hootOwnNotes({ ...r, file: 'rio_2026-03-14_20-14-20.hoot', bus: 'rio' }, 'ABC_2026-03-14_20-14-20.hoot', [])).toEqual(['This log is the .hoot itself.'])
  })
  it('names the nearest later file on the same bus the same day, with the seconds after this one ends, no threshold', () => {
    const others = ['ABC_2026-03-14_20-20-00.hoot', 'ABC_2026-03-14_20-16-30.hoot', 'ABC_2026-03-14_20-14-00.hoot', 'DEF_2026-03-14_20-15-00.hoot', 'ABC_2026-03-15_01-00-00.hoot']
    expect(hootOwnNotes(r, 'ABC_2026-03-14_20-14-20.hoot', others)).toEqual([
      'This log is the .hoot itself.',
      'Another file on this bus starts 30 s after this one ends: ABC_2026-03-14_20-16-30.hoot.',
    ])
  })
  it('has nothing to add when no later file is on the bus that day', () => {
    expect(hootOwnNotes(r, 'ABC_2026-03-14_20-14-20.hoot', ['ABC_2026-03-13_20-20-00.hoot', 'ABC_2026-03-15_20-20-00.hoot'])).toEqual(['This log is the .hoot itself.'])
  })
})
