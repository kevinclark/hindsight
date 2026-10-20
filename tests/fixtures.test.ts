// Core rules on small fixtures cut from the CalGames logs (fixtures/*.json). These run without the real logs.
import { describe, expect, it } from 'vitest'
import { analyzeFixture, fired } from './helpers/load.ts'

describe('Q13 fixture: auto collision, early disable, comms loss', () => {
  const { analyses, problems } = analyzeFixture('q13-auto-and-comms')
  const a = analyses[0]
  const rules = fired(a.report)
  it('lines up the DS log with the robot log', () => {
    expect(problems).toEqual([])
    expect(a.match.ds).toHaveLength(1)
    expect(a.match.ds[0].endTime).toBeCloseTo(420.46, 1)
  })
  it.each(['mech/zero-not-completed', 'comms/loss', 'comms/ds-log-truncated', 'auto/early-disable', 'collision/tilt'])('fires %s', (rule) => {
    expect(rules).toContain(rule)
  })
  it('has the evidence numbers from the Q13 analysis', () => {
    const f = (id: string) => a.report.findings.find((x) => x.rule === id)!
    expect(f('auto/early-disable').evidence['auto time left (s)']).toBeCloseTo(7.4, 1)
    expect(f('comms/loss').evidence['seconds with outputs off after each']).toBe('7.4, 4.3')
    expect(f('collision/tilt').evidence['peak (°)']).toBeCloseTo(-23.7, 1)
    expect(f('collision/tilt').severity).toBe('error')
    expect(f('mech/zero-not-completed').evidence['zero completed (robot time, s)']).toBeCloseTo(293.53, 2)
  })
})

describe('Q21 fixture: flywheel followers', () => {
  const a = analyzeFixture('q21-follower-mismatch').analyses[0]
  it('fires mech/follower-mismatch on follower 17 or 18', () => {
    const f = a.report.findings.find((x) => x.rule === 'mech/follower-mismatch')
    expect(f).toBeDefined()
    expect(f!.title).toMatch(/follower 1[78]/)
  })
})

describe('P0 fixture: brownout', () => {
  const a = analyzeFixture('p0-brownout').analyses[0]
  const rules = fired(a.report)
  it.each(['power/brownout', 'can/device-dropout', 'build/dirty'])('fires %s', (rule) => {
    expect(rules).toContain(rule)
  })
  it('stays quiet on mech/zero-not-completed (the hood zeroed at boot, 8ba92cb)', () => {
    expect(rules).not.toContain('mech/zero-not-completed')
    expect(a.report.skipped.map((s) => s.rule)).not.toContain('mech/zero-not-completed')
  })
  it('has the brownout and dropout numbers from the P0 analysis', () => {
    const b = a.report.findings.find((x) => x.rule === 'power/brownout')!
    expect(b.time).toBeCloseTo(532.77, 2)
    const d = a.report.findings.find((x) => x.rule === 'can/device-dropout')!
    expect(d.title).toMatch(/follower 16 dropped off CAN 7 times/)
    expect(d.causes[0]).toMatchObject({ id: 'battery-sag', likely: true })
  })
})
