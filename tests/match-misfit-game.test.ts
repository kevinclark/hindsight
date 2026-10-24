// A log no profile fits plays its season's game (src/profiles/games.ts), not lengths measured from the log.
import { describe, expect, it } from 'vitest'
import { buildMatch } from '../src/match/match.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

/**
 * A practice log: auto 10-25 s, a 13 s teleop (28-41 s), then enabled again 60-80 s. Measured, teleop is 13 s; off the
 * field the window is every run (ADR 8), so the later run is inside it either way (three runs: a gap of 3 s or more starts a new one).
 */
function practice(clockMs?: number) {
  const entries: FixtureEntry[] = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[5, false], [10, true], [25, false], [28, true], [41, false], [60, true], [80, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[5, true], [26, false]] },
  ]
  if (clockMs !== undefined) entries.push(
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[0, true]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[0, clockMs * 1000], [90, (clockMs + 90e3) * 1000]] },
  )
  return openWpilog(writeWpilog(entries))
}

const misfitMatch = (clockMs?: number) => {
  const log = practice(clockMs)
  const { profile, choice } = chooseProfile(log, PROFILES)
  return { match: buildMatch('practice.wpilog', log, profile, choice), choice }
}

describe('a log no profile fits', () => {
  it('fits no profile (the premise)', () => {
    expect(misfitMatch(Date.UTC(2025, 5, 1, 16)).choice.misfit).toBe(true)
  })

  it('plays its season\'s game: the later enable is inside the match, as with a profile that fits', () => {
    const { match } = misfitMatch(Date.UTC(2025, 5, 1, 16))
    expect(match.profile.game).toEqual({ name: '2025 REEFSCAPE', autoSeconds: 15, teleopSeconds: 135 })
    expect([match.matchStart, match.teleopStart, match.matchEnd]).toEqual([10, 28, 80])
  })

  it('takes 2026\'s lengths in 2026, not the 15 s / 135 s it fell back to', () => {
    expect(misfitMatch(Date.UTC(2026, 1, 20, 16)).match.profile.game).toEqual({ name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 })
  })

  it('measures the lengths when the log has no date', () => {
    const { match } = misfitMatch()
    expect(match.profile.game).toEqual({ name: 'measured from this log', autoSeconds: 15, teleopSeconds: 13 })
    expect(match.matchEnd).toBe(80)
    // A gap of exactly 3 s (auto 25 to teleop 28) is not shorter than the join gap: three runs.
    expect(match.runs).toEqual([{ start: 10, end: 25, auto: true }, { start: 28, end: 41, auto: false }, { start: 60, end: 80, auto: false }])
  })

  it('measures the lengths of a log dated before the first kickoff listed', () => {
    expect(misfitMatch(Date.UTC(2023, 0, 3, 16)).match.profile.game.name).toBe('measured from this log')
  })

  it('says the lengths are the season\'s game', () => {
    expect(misfitMatch(Date.UTC(2025, 5, 1, 16)).choice.note).toMatch(/auto and teleop lengths are the season's game \(measured from this log when it has no date or predates 2023\)/)
  })
})
