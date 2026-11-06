// How a profile's pinned code reads: "Code as of main 1a2b3c4", or "Code not known" when the profile names no commit.
import { describe, expect, it } from 'vitest'
import { chooseProfile } from '../src/profiles/choose.ts'
import { hasPin, pinText } from '../src/profiles/pin.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

const noPin: RobotProfile['code'] = { repo: 'unknown (built from a public log)', branch: 'unknown', sha: 'unknown' }

const pinned: RobotProfile['code'] = { repo: 'r', branch: 'main', sha: 'def5678' }

describe('the code a profile is pinned to', () => {
  it('a known pin keeps the words it always had', () => {
    expect(hasPin(pinned)).toBe(true)
    expect(pinText({ branch: 'main', sha: 'def5678abc' })).toBe('def5678 on main')
  })
  it('a profile with no known commit says "Code not known"', () => {
    expect(hasPin(noPin)).toBe(false)
    expect(pinText(noPin)).toBe('')
  })
  it('the "no profile is pinned" note leaves out an unknown pin', () => {
    const unpinned: RobotProfile = { ...offseason2026, codebase: 'Invented', code: noPin }
    const log = openWpilog(writeWpilog([
      { name: '/RealMetadata/Codebase', type: 'string', records: [[0, 'Invented']] },
      { name: '/RealMetadata/GitBranch', type: 'string', records: [[0, 'topic']] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5]] },
    ] as Parameters<typeof writeWpilog>[0]))
    const { choice } = chooseProfile(log, [unpinned])
    expect(choice.note).not.toMatch(/unknown/)
    expect(choice.note).toMatch(/code not known/i)
  })
})
