// mech/follower-mismatch, stopped-follower branch, on made-up logs for the 2026 offseason robot's flywheel group.
// The real cases (two 2026 practice logs) are not in the repo; their numbers are in the rule's header.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const enabledFrom20To60: FixtureEntry = { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [60, false]] }
const battery: FixtureEntry = { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.5], [70, 12.5]] }

/** A signal logged every 20 ms from 20 s to 60 s, its value a function of time. */
function every20ms(name: string, value: (t: number) => number): FixtureEntry {
  const records: [number, number][] = []
  for (let i = 0; i <= 2000; i++) records.push([20 + i * 0.02, value(20 + i * 0.02)])
  return { name, type: 'double', records }
}

/** The leader's own loop swinging 30 to 55 rot/s every half second, so it never holds a steady speed. */
const swinging = (t: number) => (Math.floor(t * 2) % 2 === 0 ? 30 : 55)

function run(leader: (t: number) => number, follower: (t: number) => number, enabled = enabledFrom20To60) {
  const entries = [
    enabled, battery,
    every20ms('/Drum/Flywheel/Leader/VelocityRotPerSec', leader),
    every20ms('/Drum/Flywheel/Follower 0/VelocityRotPerSec', follower),
    every20ms('/Drum/Flywheel/Follower 1/VelocityRotPerSec', leader),
    every20ms('/Drum/Flywheel/Follower 2/VelocityRotPerSec', leader),
  ]
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].report
}
const mismatch = (report: ReturnType<typeof run>) => report.findings.find((f) => f.rule === 'mech/follower-mismatch')

/** A follower that follows the leader except for `seconds` from 30 s, when it sits at 3 % of it. */
const stoppedFor = (seconds: number) => (t: number) => (t >= 30 && t < 30 + seconds ? 0.03 * swinging(t) : swinging(t))

describe('mech/follower-mismatch: a follower that is not turning', () => {
  it('fires after 2 s stopped, with a leader that never holds a steady speed', () => {
    const f = mismatch(run(swinging, stoppedFor(2.5)))
    expect(f?.title).toMatch(/Flywheel/)
    expect(f?.evidence['stopped follower']).toBe('Flywheel follower 16')
    expect(f?.evidence['Flywheel follower 16: seconds under 20 % of the leader']).toBe(2.5)
    expect(f?.evidence['Flywheel follower 16: median speed vs leader while stopped (%)']).toBe(3)
    expect(f?.time).toBeCloseTo(30, 1)
    expect(f?.causes.filter((c) => c.likely).map((c) => c.id)).toEqual(['stopped', 'motor-fault'])
  })
  it('stays quiet at 1.9 s stopped', () => {
    expect(mismatch(run(swinging, stoppedFor(1.9)))).toBeUndefined()
  })
  it('stays quiet when the leader runs below 20 rot/s', () => {
    const slow = (t: number) => (Math.floor(t * 2) % 2 === 0 ? 8 : 18)
    expect(mismatch(run(slow, (t) => (t >= 30 && t < 36 ? 0.03 * slow(t) : slow(t))))).toBeUndefined()
  })
  it('counts only the enabled part of a stop that runs on while the robot is disabled', () => {
    // Enabled 20 to 32 s and 50 to 51 s, disabled between. The follower sits still from 30.1 s to 50 s.
    const twice: FixtureEntry = { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [32, false], [50, true], [51, false]] }
    const f = mismatch(run(swinging, (t) => (t >= 30 && t < 50 ? 0.03 * swinging(t) : swinging(t)), twice))
    expect(f?.evidence['Flywheel follower 16: seconds under 20 % of the leader']).toBe(2)
    expect(mismatch(run(swinging, (t) => (t >= 30.1 && t < 50 ? 0.03 * swinging(t) : swinging(t)), twice))).toBeUndefined()
  })
})
