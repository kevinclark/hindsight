// Which robots the Session view's and Match review's lists offer. Teams here are invented (9999, 9998) except the built-in profiles' own.
import { describe, expect, it } from 'vitest'
import { PROFILES, profileId } from '../src/profiles/index.ts'
import { robotChoices } from '../src/ui/robot-list.ts'
import { toProfile, type ProfileJson } from '../src/builder/json.ts'
import type { RobotProfile } from '../src/profiles/types.ts'

const base = PROFILES[0]
const mine: RobotProfile = { ...base, name: 'Robot nine', team: 9999, keptAs: 'kept:nine' }
const other: RobotProfile = { ...base, name: 'Robot eight', team: 9998, keptAs: 'kept:eight' }
const untied: RobotProfile = { ...base, name: 'Robot no team', team: undefined, keptAs: 'kept:none' }
const builtIn: RobotProfile[] = [{ ...base, name: 'Built in nine', team: 9999 }, { ...base, name: 'Built in eight', team: 9998 }]
const ids = (g: { profiles: RobotProfile[] }) => g.profiles.map(profileId)

describe('robot list with a team set', () => {
  it("shows the team's built-in profiles, then kept ones that are the team's or have no team; leaves other teams out", () => {
    const groups = robotChoices(builtIn, [mine, other, untied], 9999)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(ids(groups[0])).toEqual([profileId(builtIn[0]), 'kept:nine', 'kept:none'])
  })
  it("keeps another team's robot that this session's logs use, under that team's heading", () => {
    const groups = robotChoices(builtIn, [mine, other], 9999, ['kept:eight'])
    expect(groups.map((g) => g.label)).toEqual([null, 'Team 9998'])
    expect(ids(groups[1])).toEqual(['kept:eight'])
  })
  it('does not list a used robot twice when it is already the team\'s', () => {
    const groups = robotChoices(builtIn, [mine], 9999, ['kept:nine'])
    expect(groups).toHaveLength(1)
    expect(ids(groups[0]).filter((i) => i === 'kept:nine')).toHaveLength(1)
  })
  it('with the real built-in profiles and team 8033 offers 4 of the 8', () => {
    const groups = robotChoices(PROFILES, [], 8033)
    expect(groups).toHaveLength(1)
    expect(PROFILES).toHaveLength(8)
    expect(groups[0].profiles.map((p) => p.team)).toEqual([8033, 8033, 8033, 8033])
  })
})

describe('robot list with no team set', () => {
  it('shows every profile, grouped by team in the order they come, kept profiles without a team under "No team"', () => {
    const groups = robotChoices(builtIn, [mine, other, untied], null)
    expect(groups.map((g) => g.label)).toEqual(['Team 9999', 'Team 9998', 'No team'])
    expect(groups.flatMap(ids)).toHaveLength(5)
    expect(ids(groups[0])).toEqual([profileId(builtIn[0]), 'kept:nine'])
  })
  it('lists all 8 built-in profiles', () => {
    expect(robotChoices(PROFILES, [], null).flatMap((g) => g.profiles)).toEqual(expect.arrayContaining(PROFILES))
    expect(robotChoices(PROFILES, [], null).flatMap((g) => g.profiles)).toHaveLength(8)
  })
})

describe('the team field', () => {
  it('a profile.json without a team becomes a profile without one', () => {
    const json: ProfileJson = { name: 'Robot nine', motorGroups: [] }
    expect('team' in toProfile(json)).toBe(false)
  })
  it('a profile.json with a team keeps it', () => {
    expect(toProfile({ name: 'Robot nine', team: 9999, motorGroups: [] }).team).toBe(9999)
  })
})
