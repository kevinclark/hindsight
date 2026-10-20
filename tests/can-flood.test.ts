// A whole-robot CAN flood (CalGames 2026 Q2: 25 devices dropped within 0.3 s): the 2026 profile's bus members, the
// 'dropped with' evidence that nests the rest of a cluster under its first device, and the alert words that tie
// "turn motor" and "encoder" alerts to the bus. Built on small synthetic logs; the real Q2 log is in
// calgames-logs.test.ts when it is in ~/Downloads.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { nest } from '../src/report/finding-tree.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { BUS_DEVICES } from '../src/rules/can/bus-dropout.ts'
import { LINKS } from '../src/rules/index.ts'
import { linkFindings } from '../src/rules/run.ts'
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
const unmapped = { ...offseason2026, canBuses: undefined }
const droppedWith = (f: Finding) => f.evidence['dropped with']

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

describe('can/device-dropout: dropped with', () => {
  const names = (found: Finding[]) => found.filter((f) => f.rule === 'can/device-dropout')

  it('the first device of a cluster has none; a tie goes to the device earlier in the profile; a lone drop has none', () => {
    const [a, b, c, d] = [devices[1], devices[0], devices[12], devices[15]] // b is before a in the profile
    const found = names(run(log({
      [a.name]: [[5, true], [40, false], [45, true]],
      [b.name]: [[5, true], [40, false], [45, true]], // the same instant as a: b is first in profile order
      [c.name]: [[5, true], [40.5, false], [45, true]], // within 1 s of both
      [d.name]: [[5, true], [60, false], [61, true]], // alone
    }), unmapped))
    const by = Object.fromEntries(found.map((f) => [f.about, droppedWith(f)]))
    expect(by).toEqual({ [b.name]: undefined, [a.name]: b.name, [c.name]: b.name, [d.name]: undefined })
    // The head's evidence has no such line at all, not an empty one.
    expect('dropped with' in found.find((f) => f.about === b.name)!.evidence).toBe(false)
  })

  it('a device whose first drop is alone is judged by that drop, even if a later one clusters', () => {
    const [a, b] = [devices[0], devices[1]]
    const found = names(run(log({
      [a.name]: [[5, true], [30, false], [31, true], [50, false], [51, true]],
      [b.name]: [[5, true], [50, false], [51, true]],
    }), unmapped))
    // a's first drop (30 s) is alone, so a has no 'dropped with' even though b's drop at 50 s matches a's second.
    expect(found.find((f) => f.about === a.name)!.evidence['dropped with']).toBeUndefined()
    // b's first drop (50 s) is within 1 s of a's second drop, which is a's own drop, so b names a.
    expect(found.find((f) => f.about === b.name)!.evidence['dropped with']).toBe(a.name)
  })

  it('a chain of drops each under 1 s from the last still points at earlier ones only (no loop)', () => {
    const drops = Object.fromEntries([0, 1, 2, 3].map((i) => [devices[i].name, [[5, true], [40 + i * 0.8, false], [45, true]] as [number, boolean][]]))
    const found = names(run(log(drops), unmapped))
    const all = found.map((f) => ({ ...f }))
    linkFindings(all, LINKS)
    // Every finding has at most one explainer, and following explainers always ends at the first device.
    for (const f of all) {
      let at: Finding | undefined = f
      for (let hops = 0; at?.explainedBy; hops++) {
        expect(hops).toBeLessThan(all.length)
        at = all.find((x) => x.about === at!.explainedBy!.about)
      }
      expect(at!.about).toBe(devices[0].name)
    }
  })

  it('the silent failure: a member already down when the bus goes means no bus finding, and the rest still nest under one headline', () => {
    // Hood has been off since before the robot enabled, so the bus is not "every member at once".
    const drops: Record<string, [number, boolean][]> = { [devices.find((d) => d.name === 'Hood')!.name]: [[5, false]] }
    const going = devices.filter((d) => d.name !== 'Hood')
    going.forEach((d, i) => { drops[d.name] = [[5, true], [40 + i * 0.04, false], [50, true]] })
    const found = run(log(drops))
    expect(found.filter((f) => f.rule === 'can/bus-dropout')).toEqual([])
    const per = found.filter((f) => f.rule === 'can/device-dropout')
    expect(per).toHaveLength(25)
    const head = going[0].name
    expect(per.filter((f) => f.about !== 'Hood' && droppedWith(f) === undefined).map((f) => f.about)).toEqual([head])
    expect(per.filter((f) => f.about !== 'Hood' && f.about !== head).every((f) => f.explainedBy?.about === head)).toBe(true)
    expect(per.find((f) => f.about === 'Hood')!.explainedBy).toBeUndefined()
    // One headline for the cluster (with the other 23 under it) and one for Hood.
    const tree = nest(per, found)
    expect(tree.map((n) => n.finding.about).sort()).toEqual([head, 'Hood'].sort())
    expect(tree.find((n) => n.finding.about === head)!.children).toHaveLength(23)
  })

  it('a whole-bus drop is still one bus finding with no per-device findings', () => {
    const drops = Object.fromEntries(devices.map((d, i) => [d.name, [[5, true], [40 + i * 0.01, false], [50, true]] as [number, boolean][]]))
    const found = run(log(drops))
    expect(found.filter((f) => f.rule === 'can/bus-dropout')).toHaveLength(1)
    expect(found.filter((f) => f.rule === 'can/device-dropout')).toEqual([])
  })
})

describe('the same-rule link', () => {
  const dropout = (about: string, more: Finding['evidence'] = {}): Finding => ({
    rule: 'can/device-dropout', severity: 'error', title: about, time: 40, matchTime: null, when: null, about, key: `can/device-dropout · ${about}`,
    evidence: more, meaning: '', causes: [], nextStep: '',
  })

  it('explains only the findings that name it, and leaves the first alone', () => {
    const first = dropout('A')
    const second = dropout('B', { 'dropped with': 'A' })
    const third = dropout('C')
    linkFindings([first, second, third], LINKS)
    expect([first.explainedBy, third.explainedBy]).toEqual([undefined, undefined])
    expect(second.explainedBy).toMatchObject({ rule: 'can/device-dropout', about: 'A' })
    expect(second.explainedBy!.why).toMatch(/within 1 s of the first device to drop: one event/)
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
    linkFindings([bus, ...alerts], LINKS)
    expect(alerts.map((a) => a.explainedBy?.rule)).toEqual(Array(4).fill('can/bus-dropout'))
  })

  it('an alert that names no kind of device on the bus is still its own headline', () => {
    const odometry = alert('Using Sync Odometry')
    const far = alert('Disconnected turn motor on Back Left module!', 700)
    linkFindings([bus, odometry, far], LINKS)
    expect([odometry.explainedBy, far.explainedBy]).toEqual([undefined, undefined])
  })

  it('turn and module mean steer only when the bus has a steer motor', () => {
    const noSteer = { ...bus, evidence: { [BUS_DEVICES]: 'Front Left drive, Hood, Gyro (Pigeon)' } }
    const turn = alert('Disconnected turn motor on Back Left module!')
    linkFindings([noSteer, turn], LINKS)
    expect(turn.explainedBy).toBeUndefined()
  })
})
