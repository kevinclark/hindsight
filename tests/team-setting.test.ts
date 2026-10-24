// The team number and GitHub sources a user saves: what is accepted, and the words for what is not. Team 9999 and example-org are invented.
import { describe, expect, it } from 'vitest'
import { checkTeamSetting, needsLinkPass, sameSources, validTeam } from '../src/hub/team-setting.ts'

describe('team number', () => {
  it('is a whole number from 1 to 99999', () => {
    for (const n of [1, 8033, 99999]) expect(validTeam(n)).toBe(true)
    for (const n of [0, -5, 100000, 12.5, NaN, '9999', null, undefined]) expect(validTeam(n)).toBe(false)
  })
})

describe('saving the team setting', () => {
  it('keeps a valid team and sources together, trimmed and without repeats', () => {
    expect(checkTeamSetting(9999, [' example-org ', 'example-org', 'example-org/robot-9999', ''])).toEqual({ team: 9999, sources: ['example-org', 'example-org/robot-9999'] })
  })
  it('lets the team be left empty (null, undefined or an empty box)', () => {
    for (const none of [null, undefined, '']) expect(checkTeamSetting(none, ['example-org'])).toEqual({ team: null, sources: ['example-org'] })
  })
  it('refuses a team number that is not a whole number from 1 to 99999, saying so', () => {
    for (const bad of [0, 100000, 1.5, 'abc', NaN]) expect(() => checkTeamSetting(bad, [])).toThrow('A team number is a whole number from 1 to 99999.')
  })
  it('refuses a source that is not an organization or owner/name, naming it', () => {
    expect(() => checkTeamSetting(9999, ['example-org', 'a/b/c'])).toThrow('"a/b/c" is not a GitHub organization (name) or repository (owner/name).')
    expect(() => checkTeamSetting(9999, ['https://github.com/example-org'])).toThrow('is not a GitHub organization')
  })
  it('refuses both before saving anything: a bad team throws even with good sources', () => {
    expect(() => checkTeamSetting(0, ['example-org'])).toThrow('team number')
  })
  it('treats sources that are not a list as none', () => {
    expect(checkTeamSetting(9999, 'example-org')).toEqual({ team: 9999, sources: [] })
  })
})

describe('when saving runs the link pass', () => {
  it('compares sources as a set: order and repeats do not matter', () => {
    expect(sameSources(['example-org', 'example-org/robot-9999'], ['example-org/robot-9999', 'example-org', 'example-org'])).toBe(true)
    expect(sameSources(['example-org'], ['example-org', 'other-org'])).toBe(false)
  })
  it('runs when the sources changed', () => {
    expect(needsLinkPass([], ['example-org'])).toBe(true)
    expect(needsLinkPass(['example-org'], ['example-org', 'other-org'])).toBe(true)
  })
  it('runs again when the last pass did not finish (its sources were never recorded)', () => {
    expect(needsLinkPass([], ['example-org'])).toBe(true)
  })
  it('does not run when only the team number changed, or when no source is left', () => {
    expect(needsLinkPass(['example-org'], ['example-org'])).toBe(false)
    expect(needsLinkPass(['a-org', 'b-org'], ['b-org', 'a-org'])).toBe(false)
    expect(needsLinkPass(['example-org'], [])).toBe(false)
  })
})
