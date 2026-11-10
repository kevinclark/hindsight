// Contract tests for mech/motor-running-free: each test proves the obligations its name starts with, in
// docs/contracts/motor-running-free.md. Made-up robot (a group, "Belt", of two or four motors) and made-up logs, run
// through the runner so what is checked is what a student sees: the finding, or the "not checked" line.
import { expect, test } from 'vitest'
import runningFree from '../src/rules/mech/running-free.ts'
import { runRules } from '../src/rules/run.ts'
import { buildMatch } from '../src/match/match.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { offseason2026, offseason2026Event } from '../src/profiles/2026-offseason.ts'
import type { Motor, RobotProfile } from '../src/profiles/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const motor = (i: number, withVelocity = true): Motor => ({
  name: `Belt ${i}`,
  statorCurrent: `/Belt/${i}/StatorAmps`,
  ...(withVelocity ? { velocity: `/Belt/${i}/Velocity` } : {}),
  connected: `/Belt/${i}/Connected`,
})
const limits = { supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'BeltIO.java:1' }

function robot(count = 2, velocityOnFirstOnly = false, withConnected = true, noVelocity: number[] = []): RobotProfile {
  const motors = Array.from({ length: count }, (_, i) => {
    const m = motor(i, (!velocityOnFirstOnly || i === 0) && !noVelocity.includes(i))
    if (!withConnected) delete m.connected
    return m
  })
  return { ...offseason2026, name: 'Test robot', codebase: 'TestBot', motorGroups: [{ name: 'Belt', sameLoop: true, motors, limits }], otherDevices: [], canBuses: undefined, stateMachine: undefined }
}

/** A value per 20 ms from 10 s to 40 s, from a function of time. */
const every20ms = (name: string, value: (t: number) => number | boolean, type: 'double' | 'boolean' = 'double', until = 40.001): FixtureEntry => {
  const records: [number, number | boolean][] = []
  for (let t = 10; t <= until; t += 0.02) records.push([Math.round(t * 100) / 100, value(t)])
  return { name, type, records }
}

interface Motion {
  /** Speed and stator current of motor i at time t (default: 12 rot/s on 20 A, for all). */
  speed?: (i: number, t: number) => number
  amps?: (i: number, t: number) => number
  connected?: (i: number, t: number) => boolean
  enabled?: [number, number][]
  /** Motor index -> time only its velocity records stop (stator keeps logging). */
  stopVelocity?: Record<number, number>
  /** Motor index -> time its velocity and stator records stop. */
  stopRecords?: Record<number, number>
  /** Motor indexes whose velocity key is left out of the log (and the profile). */
  noVelocity?: number[]
  withConnected?: boolean
}

function run(m: Motion = {}, count = 2, profile = robot(count, false, m.withConnected ?? true, m.noVelocity ?? [])) {
  const entries: FixtureEntry[] = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], ...(m.enabled ?? [[10, 40]]).flatMap(([a, b]) => [[a, true], [b, false]] as [number, boolean][])] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [60, 12.4]] },
  ]
  for (let i = 0; i < count; i++) {
    const until = m.stopRecords?.[i] ?? 40.001
    if (!m.noVelocity?.includes(i)) entries.push(every20ms(`/Belt/${i}/Velocity`, (t) => (m.speed ?? (() => 12))(i, t), 'double', m.stopVelocity?.[i] ?? until))
    entries.push(every20ms(`/Belt/${i}/StatorAmps`, (t) => (m.amps ?? (() => 20))(i, t), 'double', until))
    if (m.withConnected !== false) entries.push(every20ms(`/Belt/${i}/Connected`, (t) => (m.connected ?? (() => true))(i, t), 'boolean'))
  }
  const match = buildMatch('t.wpilog', openWpilog(writeWpilog(entries)), profile)
  const report = runRules(match, [runningFree])
  expect(report.crashed).toEqual([])
  return { findings: report.findings.filter((f) => f.rule === runningFree.id), skipped: report.skipped.find((s) => s.rule === runningFree.id)?.reason }
}

/** Motor `who` runs free (10 % fast, 3 A against 20 A) from `from` for `seconds`. */
const freeFor = (who: number, from: number, seconds: number): Motion => ({
  speed: (i, t) => (i === who && t >= from && t < from + seconds ? 13.2 : 12),
  amps: (i, t) => (i === who && t >= from && t < from + seconds ? 3 : 20),
})

test('[RF-01] the rule\'s id, severity, kind and cause ids are the ones kept in saved summaries', () => {
  const { id, severity, judges, who, forEach, causes } = runningFree
  expect({ id, severity, judges, who, forEach }).toEqual({ id: 'mech/motor-running-free', severity: 'warning', judges: 'fault', who: ['pit'], forEach: 'motorGroup' })
  expect(causes.map((c) => c.id)).toEqual(['belt-off', 'loose', 'broken'])
  expect(run(freeFor(1, 20, 3)).findings[0].key).toBe('mech/motor-running-free · Belt')
})

test('[RF-02] a follower 10 % faster on 3 A against 20 A for 3 s fires once, dated at the stretch start', () => {
  const { findings } = run(freeFor(1, 20, 3))
  expect(findings).toHaveLength(1)
  expect(findings[0].time).toBeCloseTo(20, 1)
  expect(findings[0].evidence['free motor']).toBe('Belt 1')
})

test('[RF-03] it names the leader when the leader is the free motor', () => {
  const { findings } = run(freeFor(0, 20, 3))
  expect(findings[0].evidence['free motor']).toBe('Belt 0')
  expect(findings[0].title).toMatch(/^Belt 0 ran free/)
})

test('[RF-04] it does not fire at 1.5 s, and fires at 2 s', () => {
  expect(run(freeFor(1, 20, 1.5)).findings).toEqual([])
  expect(run(freeFor(1, 20, 2.1)).findings).toHaveLength(1)
  // Two separate 1.5 s stretches are not added.
  const twice: Motion = {
    speed: (i, t) => (i === 1 && ((t >= 20 && t < 21.5) || (t >= 25 && t < 26.5)) ? 13.2 : 12),
    amps: (i, t) => (i === 1 && ((t >= 20 && t < 21.5) || (t >= 25 && t < 26.5)) ? 3 : 20),
  }
  expect(run(twice).findings).toEqual([])
})

test('[RF-05] a faster motor that carries the same current is not free (a spin-up mismatch)', () => {
  const m: Motion = { speed: (i, t) => (i === 1 && t >= 20 && t < 24 ? 13.2 : 12), amps: (i, t) => (i === 1 && t >= 20 && t < 24 ? 15 : 20) }
  expect(run(m).findings).toEqual([])
})

test('[RF-06] a not-connected moment ends a stretch: two 1.5 s halves do not add up', () => {
  const m: Motion = { ...freeFor(1, 20, 3), connected: (i, t) => !(i === 0 && t >= 21.5 && t < 21.56) }
  expect(run(m).findings).toEqual([])
  expect(run(freeFor(1, 20, 3)).findings).toHaveLength(1)
})

test('[RF-06] a moment with a motor at or under 5 ends a stretch', () => {
  const base = freeFor(1, 20, 3)
  const m: Motion = { ...base, speed: (i, t) => (i === 0 && t >= 21.5 && t < 21.56 ? 4 : base.speed!(i, t)) }
  expect(run(m).findings).toEqual([])
})

test('[RF-06] a disabled stretch ends it, and disabled time does not count', () => {
  expect(run({ ...freeFor(1, 20, 3), enabled: [[10, 21.5], [21.56, 40]] }).findings).toEqual([])
  expect(run({ ...freeFor(1, 20, 10), enabled: [[10, 21]] }).findings).toEqual([])
})

test('[RF-07] a four-motor group with one free motor fires naming it', () => {
  const { findings } = run(freeFor(2, 20, 3), 4)
  expect(findings).toHaveLength(1)
  expect(findings[0].evidence['free motor']).toBe('Belt 2')
  expect(findings[0].evidence['others: median stator current (A)']).toBe(20)
})

test('[RF-08] the motors never all running is not checked, with no finding', () => {
  const { findings, skipped } = run({ speed: (i) => (i === 0 ? 12 : 2) })
  expect(findings).toEqual([])
  expect(skipped).toBe('Belt: the motors never all ran above 5 together while enabled and connected')
})

test('[RF-08] a group where fewer than two motors have a velocity key is not checked', () => {
  const { findings, skipped } = run(freeFor(1, 20, 3), 2, robot(2, true))
  expect(findings).toEqual([])
  expect(skipped).toMatch(/Belt/)
})

test('[RF-09] the title, evidence and measured numbers of a finding', () => {
  const { findings } = run(freeFor(1, 20, 3))
  const f = findings[0]
  expect(f.title).toBe('Belt 1 ran free for 3.0 s (longest stretch): 10 % faster than the others on 3 A against 20 A')
  expect(Object.keys(f.evidence)).toEqual([
    'free motor', 'longest free stretch (s)', 'total free seconds', 'stretch from (s)', 'stretch to (s)',
    'free motor: median speed', 'free motor: median stator current (A)', 'others: median speed', 'others: median stator current (A)',
  ])
  expect(f.evidence['longest free stretch (s)']).toBe(3)
  expect(f.evidence['total free seconds']).toBe(3)
  expect(f.measured?.map((m) => [m.value, m.unit, m.threshold])).toEqual([[3, 's', 2], [10, '%', undefined]])
})

test('[RF-10] the 2026 offseason profile has a Kicker group on one loop, and the event profile still gives the kickers 30 A', () => {
  const group = (p: RobotProfile, name: string) => p.motorGroups.find((g) => g.name === name)!
  const kicker = group(offseason2026, 'Kicker')
  expect(kicker.sameLoop).toBe(true)
  expect(kicker.motors.map((m) => m.name)).toEqual(['Kicker leader', 'Kicker follower'])
  expect(kicker.motors.map((m) => m.velocity)).toEqual(['/Indexer/KickerLeaderVelocityRotationsPerSec', '/Indexer/KickerFollowerVelocityRotationsPerSec'])
  const feed = group(offseason2026, 'Indexer')
  expect(feed.motors.map((m) => m.name)).toEqual(['Indexer'])
  expect(feed.motors[0].velocity).toBe('/Indexer/IndexerVelocityRotationsPerSec')
  for (const g of [kicker, feed]) expect(g.limits).toMatchObject({ supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'IndexerIO.java:170' })
  expect(group(offseason2026Event, 'Kicker').limits).toMatchObject({ supplyA: 30, where: 'IndexerIO.java:196-199' })
  expect(group(offseason2026Event, 'Indexer').limits).toMatchObject({ supplyA: 40, where: 'IndexerIO.java:170-173' })
})

test('[RF-02] the line is 2.0 s in whole 20 ms moments: 100 moments fire, 99 do not', () => {
  // Moments at 20.00 s to 21.98 s are 100 grid moments (2.00 s); one fewer is 1.98 s.
  expect(run(freeFor(1, 20, 2.0)).findings).toHaveLength(1)
  expect(run(freeFor(1, 20, 1.98)).findings).toEqual([])
})

test('[RF-03] a follower turning the opposite way (an Opposed follower) is compared by speed, not sign', () => {
  const m = freeFor(1, 20, 3)
  const { findings } = run({ ...m, speed: (i, t) => (i === 1 ? -m.speed!(i, t) : m.speed!(i, t)) })
  expect(findings).toHaveLength(1)
  expect(findings[0].evidence['free motor']).toBe('Belt 1')
  expect(findings[0].evidence['free motor: median speed']).toBeCloseTo(13.2, 1)
})

test('[RF-07] a three-motor group with one free motor fires naming it', () => {
  const { findings } = run(freeFor(1, 20, 3), 3)
  expect(findings.map((f) => f.evidence['free motor'])).toEqual(['Belt 1'])
})

test('[RF-07] known limit: two free motors in a three-motor group are silent (the median of two is the larger)', () => {
  const m: Motion = {
    speed: (i, t) => (i < 2 && t >= 20 && t < 24 ? 13.2 : 12),
    amps: (i, t) => (i < 2 && t >= 20 && t < 24 ? 3 : 20),
  }
  expect(run(m, 3).findings).toEqual([])
})

test('[RF-06] a motor with no Connected flag counts all its enabled time and is not a not-checked line', () => {
  const { findings, skipped } = run({ ...freeFor(1, 20, 3), withConnected: false })
  expect(findings).toHaveLength(1)
  expect(skipped).toBeUndefined()
})

test('[RF-11] a motor with no record on velocity and stator current for over 0.5 s is not compared, so held values do not fire', () => {
  // Motor 1 stops logging at 20 s on its free values (13.2 rot/s, 3 A) and has no Connected flag to say it is gone.
  const m: Motion = { speed: (i, t) => (i === 1 && t >= 19 ? 13.2 : 12), amps: (i, t) => (i === 1 && t >= 19 ? 3 : 20), stopRecords: { 1: 20 }, withConnected: false }
  expect(run(m).findings).toEqual([])
  // The same values still logged are a finding.
  expect(run({ ...m, stopRecords: undefined }).findings).toHaveLength(1)
})

test('[RF-11] one kind of record is enough: velocity quiet for over 0.5 s with stator current still logging is compared', () => {
  const m: Motion = { speed: (i, t) => (i === 1 && t >= 19 ? 13.2 : 12), amps: (i, t) => (i === 1 && t >= 19 ? 3 : 20), stopVelocity: { 1: 20 }, withConnected: false }
  expect(run(m).findings).toHaveLength(1)
})

test('[RF-09] the plot uses the motors the check used: a third motor with no velocity key does not stop the finding', () => {
  const { findings } = run({ ...freeFor(1, 20, 3), noVelocity: [2] }, 3)
  expect(findings).toHaveLength(1)
  expect(findings[0].evidence['free motor']).toBe('Belt 1')
  expect(findings[0].plot?.lines.length).toBe(2)
})
