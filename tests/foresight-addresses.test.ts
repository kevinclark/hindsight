import { describe, expect, it } from 'vitest'
import { robotAddresses, validTeam } from '../src/foresight/addresses.ts'

const values = (team: number | null) => robotAddresses(team).addresses.map((a) => a.value)

describe('the robot addresses come from the team number', () => {
  it('1-, 2-, 3- and 4-digit teams split as 10.TE.AM.2', () => {
    expect(values(5)).toEqual(['172.22.11.2', '10.0.5.2', 'roborio-5-frc.local'])
    expect(values(42)).toEqual(['172.22.11.2', '10.0.42.2', 'roborio-42-frc.local'])
    expect(values(254)).toEqual(['172.22.11.2', '10.2.54.2', 'roborio-254-frc.local'])
    expect(values(8033)).toEqual(['172.22.11.2', '10.80.33.2', 'roborio-8033-frc.local'])
    expect(values(9999)[1]).toBe('10.99.99.2')
    expect(values(1000)[1]).toBe('10.10.0.2')
  })
  it('no team, or one the rule cannot say: USB only, and a line says a team number adds the others', () => {
    for (const t of [null, 0, 10000, 3.5]) {
      const r = robotAddresses(t)
      expect(r.addresses.map((a) => a.value)).toEqual(['172.22.11.2'])
      expect(r.note).toMatch(/team number/)
    }
    expect(robotAddresses(254).note).toBeNull()
    expect(validTeam(254)).toBe(true)
  })
})
