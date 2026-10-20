// A whole-robot CAN flood (CalGames 2026 Q2: 25 devices dropped within 0.3 s): the 2026 profile's bus members, the
// bus-wide and partial drops, and the alert words that tie
// "turn motor" and "encoder" alerts to the bus. Built on small synthetic logs; the real Q2 log is in
// calgames-logs.test.ts when it is in ~/Downloads.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { BUS_DEVICES } from '../src/rules/can/bus-dropout.ts'
import { LINKS } from '../src/rules/index.ts'
import { consolidate } from '../src/rules/run.ts'
import { bottomLine, reviewCard, reviewModel } from '../src/report/review-model.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import type { Finding } from '../src/rules/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const WALL = 1762637000 // epoch seconds

/** The profile's CAN devices, in profile order, with their Connected keys. */
const devices = [
  ...offseason2026.motorGroups.flatMap((g) => g.motors.flatMap((m) => (m.connected ? [{ name: m.name, key: m.connected }] : []))),
  ...offseason2026.otherDevices.map((d) => ({ name: d.name, key: d.connected })),
]

/**
 * A 2026-robot log, enabled 20–80 s. Every device reports connected, except where `drops` gives its Connected flag's
 * records: [time, connected] pairs after an initial true at 5 s.
 */
function log(drops: Record<string, [number, boolean][]>): FixtureEntry[] {
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[5, false], [20, true], [80, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[5, true]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[5, (WALL + 5) * 1e6], [90, (WALL + 90) * 1e6]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[5, 12.5], [90, 12.4]] },
    ...devices.map((d): FixtureEntry => ({ name: d.key, type: 'boolean', records: drops[d.name] ?? [[5, true]] })),
  ]
}

const run = (entries: FixtureEntry[], profile = offseason2026) =>
  analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(entries) }], profile).analyses[0].report.findings

describe('the 2026 profile\'s CAN bus', () => {
  const [bus] = offseason2026.canBuses ?? []

  it('has the 19 motors with a Connected flag and the 6 CAN devices, and no camera', () => {
    expect(offseason2026.canBuses).toHaveLength(1)
    expect(bus.members).toHaveLength(25)
    expect(bus.members.map((m) => m.name)).toEqual(devices.map((d) => d.name))
    expect(bus.members.map((m) => m.key)).toEqual(devices.map((d) => d.key))
    expect(bus.members.filter((m) => /apriltag|vision|camera/i.test(m.key + m.name))).toEqual([])
  })
})

describe('can/device-dropout: bus-wide and partial drops', () => {
  it('the silent failure: a member already down when the bus goes means no bus finding, but every device still has its own finding', () => {
    // Hood has been off since before the robot enabled, so the bus is not "every member at once".
    const drops: Record<string, [number, boolean][]> = { [devices.find((d) => d.name === 'Hood')!.name]: [[5, false]] }
    const going = devices.filter((d) => d.name !== 'Hood')
    going.forEach((d, i) => { drops[d.name] = [[5, true], [40 + i * 0.04, false], [50, true]] })
    const found = run(log(drops))
    expect(found.filter((f) => f.rule === 'can/bus-dropout')).toEqual([])
    const per = found.filter((f) => f.rule === 'can/device-dropout')
    expect(per).toHaveLength(25)
    expect(per.map((f) => f.about).sort()).toEqual(devices.map((d) => d.name).sort())
  })

  it('the net under it: the 24 that dropped together get one parent, which adds nothing to any count', () => {
    const drops: Record<string, [number, boolean][]> = { Hood: [[5, false]] }
    devices.filter((d) => d.name !== 'Hood').forEach((d, i) => { drops[d.name] = [[5, true], [40 + i * 0.04, false], [50, true]] })
    const [analysis] = analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(log(drops)) }], offseason2026).analyses
    const { findings, parents = [] } = analysis.report
    expect(parents.map((p) => p.title)).toEqual(['24 CAN devices dropped within 0.92 s'])
    const grouped = findings.filter((f) => f.explainedBy?.rule === 'can/devices-dropped-together')
    expect(grouped).toHaveLength(24)
    expect(findings.find((f) => f.about === 'Hood')?.explainedBy).toBeUndefined()
    const model = reviewModel(analysis, new Map())
    expect(model.errors).toHaveLength(25)
    // Hood went first (off since before enable), then the group: report order, the group where its first device was.
    expect(model.headlines.map((n) => n.finding.about ?? n.finding.title)).toEqual(['Hood', '24 CAN devices dropped within 0.92 s'])
    expect(model.headlines[1].children).toHaveLength(24)
    expect(model.bottomLine).toMatch(/^25 errors, .*Worst: Hood dropped off CAN .*; \+24 more errors\.$/)
    // When the group is the worst headline, it stands for its errors.
    expect(bottomLine(model.errors, [], [], 0, { title: parents[0].title, covers: 24 })).toBe('25 errors, 0 warnings, 0 info. Worst: 24 CAN devices dropped within 0.92 s; +1 more error.')
    const card = reviewCard(model)
    expect(card.heading).toBe('25 errors')
    expect(card.items.map((it) => it.title)[1]).toBe('24 CAN devices dropped within 0.92 s')
    expect(card.items[1].number).toBe('explains 24 errors')
    expect(JSON.stringify(buildFindingsJson(analysis.match, analysis.report))).toContain('"parents":[{"rule":"can/devices-dropped-together"')
  })

  it('a parent marked known still heads its new members in the active list, and no count moves', () => {
    const drops: Record<string, [number, boolean][]> = {}
    devices.slice(0, 4).forEach((d, i) => { drops[d.name] = [[5, true], [40 + i * 0.1, false], [50, true]] })
    const [analysis] = analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(log(drops)) }], { ...offseason2026, canBuses: undefined }).analyses
    const [group] = analysis.report.parents ?? []
    const known = new Map([[group.key, { type: 'issue' as const, key: group.key, status: 'known' as const, note: '', when: '2026-10-20T00:00:00Z' }]])
    const model = reviewModel(analysis, known)
    expect([model.errors.length, model.known.length]).toEqual([4, 0])
    expect(model.headlines.map((n) => [n.finding, n.children.length])).toEqual([[group, 4]])
    expect(model.knownHeadlines).toEqual([])
    // Mark one member known too: the parent heads it in the known list as well.
    known.set(analysis.report.findings[0].key, { ...known.get(group.key)!, key: analysis.report.findings[0].key })
    const split = reviewModel(analysis, known)
    expect(split.headlines.map((n) => [n.finding, n.children.length])).toEqual([[group, 3]])
    expect(split.knownHeadlines.map((n) => [n.finding, n.children.length])).toEqual([[group, 1]])
  })

  it('a whole-bus drop is still one bus finding with no per-device findings', () => {
    const drops = Object.fromEntries(devices.map((d, i) => [d.name, [[5, true], [40 + i * 0.01, false], [50, true]] as [number, boolean][]]))
    const found = run(log(drops))
    expect(found.filter((f) => f.rule === 'can/bus-dropout')).toHaveLength(1)
    expect(found.filter((f) => f.rule === 'can/device-dropout')).toEqual([])
  })
})

describe('alert words for the bus link', () => {
  const bus: Finding = {
    rule: 'can/bus-dropout', severity: 'error', title: 'bus', time: 614.1, matchTime: null, when: null, about: 'CANivore bus', key: 'can/bus-dropout · CANivore bus',
    evidence: { [BUS_DEVICES]: 'Front Left drive, Front Left steer, Hood, Front Left CANcoder, Intake CANcoder, Gyro (Pigeon)' }, meaning: '', causes: [], nextStep: '',
  }
  const alert = (text: string, time = 614.6): Finding => ({
    rule: 'alerts/passthrough', severity: 'error', title: text, time, matchTime: null, when: null, about: text, key: `alerts/passthrough · ${text}`,
    evidence: {}, meaning: '', causes: [], nextStep: '',
  })

  it('turn is steer, encoder is CANcoder, module is steer', () => {
    const alerts = [
      alert('Disconnected turn motor on Back Left module!'),
      alert('Disconnected turn encoder on Back Left module!'),
      alert('Missing Module Data', 613.9),
      alert('Disconnected drive motor on Back Left module!'),
    ]
    consolidate([bus, ...alerts], { links: LINKS })
    expect(alerts.map((a) => a.explainedBy?.rule)).toEqual(Array(4).fill('can/bus-dropout'))
  })

  it('an alert that names no kind of device on the bus is still its own headline', () => {
    const odometry = alert('Using Sync Odometry')
    const far = alert('Disconnected turn motor on Back Left module!', 700)
    consolidate([bus, odometry, far], { links: LINKS })
    expect([odometry.explainedBy, far.explainedBy]).toEqual([undefined, undefined])
  })

  it('turn and module mean steer only when the bus has a steer motor', () => {
    const noSteer = { ...bus, evidence: { [BUS_DEVICES]: 'Front Left drive, Hood, Gyro (Pigeon)' } }
    const turn = alert('Disconnected turn motor on Back Left module!')
    consolidate([noSteer, turn], { links: LINKS })
    expect(turn.explainedBy).toBeUndefined()
  })
})
