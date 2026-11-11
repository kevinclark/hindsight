// The on-check grading on the team's own logs (tests/helpers/team-logs.ts, pitEvent2026Files), replayed the way live.ts
// reads a robot. Each skips when its log isn't listed. Numbers: src/rules/mech/pair-decoupled.ts.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { buildMatch } from '../src/match/match.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { replayLive, type ReplayStep } from '../src/foresight/replay.ts'
import { markOnRun } from '../src/foresight/onchecks.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'

const files = TEAM.pitEvent2026Files ?? {}
const path = (role: keyof typeof files) => teamPath(files[role])
const have = (role: keyof typeof files) => existsSync(path(role))

function open(role: keyof typeof files) {
  const log = openWpilog(new Uint8Array(readFileSync(path(role))))
  const { profile, choice } = chooseProfile(log, PROFILES)
  return { log, profile, choice, match: buildMatch(role, log, profile, choice) }
}
const pairLine = (s: ReplayStep) => markOnRun(s.result.onchecks).find((l) => l.rules?.includes('mech/pair-decoupled'))!
/** When the kicker's first burst ended: the leader over 5 rot/s while enabled, until a gap of 0.5 s. */
function firstBurstEnd(o: ReturnType<typeof open>): number {
  const group = o.profile.motorGroups.find((g) => g.coupledPairs?.length)!
  const speed = readNumbers(o.log, group.motors.find((m) => m.name === group.coupledPairs![0].leader)!.velocity!)!
  let end = NaN
  for (let i = 0; i < speed.t.length; i++) {
    const t = speed.t[i]
    if (Math.abs(speed.v[i]) <= 5 || !o.match.enabled.some((iv) => t >= iv.start && t < iv.end)) continue
    if (Number.isFinite(end) && t - end > 0.5) break
    end = t
  }
  return end
}

describe.skipIf(!have('kickerApart'))('a pit run with the kicker apart all run', () => {
  it('goes amber during its first kicker burst, not after power-off', () => {
    const o = open('kickerApart')
    const steps = [...replayLive(o.log, o.profile, o.choice)]
    const first = steps.find((s) => pairLine(s).state === 'amber')
    expect(first).toBeDefined()
    // Within a check (1 s) of the end of the first burst, the robot still enabled.
    expect(first!.now).toBeLessThanOrEqual(firstBurstEnd(o) + 1)
    expect(first!.result.state).toBe('enabled')
    const finding = first!.result.onchecks.verdict.items.find((i) => i.finding.rule === 'mech/pair-decoupled')!.finding
    expect(first!.now).toBeLessThan(o.match.logEnd)
    expect(finding.evidence['ran free']).toBe('Kicker leader')
  })
})

describe.skipIf(!have('kickerApartThenFine'))('a pit run apart in its first enable and together in its last', () => {
  it('flags the first burst and says it came back together later', () => {
    const o = open('kickerApartThenFine')
    const steps = [...replayLive(o.log, o.profile, o.choice)]
    const firstAmber = steps.findIndex((s) => pairLine(s).state === 'amber')
    expect(firstAmber).toBeGreaterThanOrEqual(0)
    const last = steps[steps.length - 1]
    expect(pairLine(last).state).toBe('amber')
    expect(pairLine(last).detail).toMatch(/together again for \d+\.\d s after/)
    const finding = last.result.onchecks.verdict.items.find((i) => i.finding.rule === 'mech/pair-decoupled')!.finding
    expect(finding.evidence['cleared later in the log']).toBe('yes')
    expect(finding.evidence['ran free']).toBe('Kicker follower')
  })
})

describe.skipIf(!have('healthyPitEndsEnabled'))('a healthy pit run powered off while enabled', () => {
  it('shows its grade (OK) before the log ends, while still enabled', () => {
    const o = open('healthyPitEndsEnabled')
    const from = o.match.enabled[0].start - 5
    const steps = [...replayLive(o.log, o.profile, o.choice, { from })]
    const last = steps[steps.length - 1]
    expect(last.result.state).toBe('enabled')
    expect(pairLine(last).state).toBe('ok')
    expect(steps.every((s) => s.result.state !== 'checked' || s.result.verdict.verdict !== 'GO' || s.now < o.match.enabled[0].start)).toBe(true)
  })
})

describe.skipIf(!have('healthyPit'))('a healthy pit run', () => {
  it('has no pair finding and its line reads OK once the kicker ran', () => {
    const o = open('healthyPit')
    const steps = [...replayLive(o.log, o.profile, o.choice)]
    expect(steps.some((s) => pairLine(s).state === 'amber' || pairLine(s).state === 'red')).toBe(false)
    expect(pairLine(steps[steps.length - 1]).state).toBe('ok')
  })
})

describe.skipIf(!have('kickerApartMatch') || !have('healthyMatch'))('matches', () => {
  const analyse = (role: keyof typeof files) => analyzeFiles([{ name: 'm.wpilog', bytes: new Uint8Array(readFileSync(path(role))) }]).analyses[0].report
  it('a match played with the kicker apart: one amber finding naming the leader as free', () => {
    const f = analyse('kickerApartMatch').findings.filter((x) => x.rule === 'mech/pair-decoupled')
    expect(f).toHaveLength(1)
    expect(f[0].evidence['ran free']).toBe('Kicker leader')
    expect(f[0].evidence['longest stretch apart (s)']).toBeGreaterThan(10)
  })
  it('a healthy match: none', () => {
    expect(analyse('healthyMatch').findings.filter((x) => x.rule === 'mech/pair-decoupled')).toEqual([])
  })
})
