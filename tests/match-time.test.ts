// Times read in match time first, robot time in parentheses (what AdvantageScope shows).
import { describe, expect, it } from 'vitest'
import { clock, matchWhen, type Match } from '../src/match/match.ts'

const match = {
  matchStart: 400, teleopStart: 423, matchEnd: 560,
  auto: [{ start: 400, end: 420 }], teleop: [{ start: 423, end: 560 }],
} as unknown as Match

describe('match time', () => {
  it('formats seconds as m:ss', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(107.9)).toBe('1:47')
  })
  it('says match time first, phase and robot time in parentheses', () => {
    expect(matchWhen(match, 412.3)).toBe('0:12 into the match (auto; robot time 412.3 s)')
    expect(matchWhen(match, 507)).toBe('1:47 into the match (teleop; robot time 507.0 s)')
    expect(matchWhen(match, 421)).toBe('0:21 into the match (disabled; robot time 421.0 s)')
  })
  it('says before or after the match outside it, and robot time alone with no match', () => {
    expect(matchWhen(match, 100)).toBe('before the match (robot time 100.0 s)')
    expect(matchWhen(match, 600)).toBe('after the match (robot time 600.0 s)')
    expect(matchWhen({ ...match, matchStart: null } as Match, 100)).toBe('robot time 100.0 s')
  })
})
