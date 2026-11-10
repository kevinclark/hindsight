// Coupled pairs (MotorGroup.coupledPairs) and mech/pair-decoupled, on made-up logs for the 2026 offseason robot's kicker.
// The real cases are 8033's own logs (tests/helpers/team-logs.ts, pitEvent2026Files); their numbers are in the rule's header.
import { describe, expect, it } from 'vitest'
import { offseason2026, offseason2026Event } from '../src/profiles/2026-offseason.ts'

describe('coupled pairs in the 2026 offseason profiles', () => {
  for (const profile of [offseason2026, offseason2026Event]) {
    it(`${profile.name} (${profile.code.branch}) names the kicker pair, each motor with its velocity key`, () => {
      const groups = profile.motorGroups.filter((g) => g.coupledPairs?.length)
      expect(groups).toHaveLength(1)
      const [group] = groups
      expect(group.coupledPairs).toEqual([{ name: 'Kicker', leader: 'Kicker leader', follower: 'Kicker follower', where: expect.stringMatching(/IndexerIO\.java/) }])
      const motor = (name: string) => group.motors.find((m) => m.name === name)
      expect(motor('Kicker leader')?.velocity).toBe('/Indexer/KickerLeaderVelocityRotationsPerSec')
      expect(motor('Kicker follower')?.velocity).toBe('/Indexer/KickerFollowerVelocityRotationsPerSec')
    })
  }
})
