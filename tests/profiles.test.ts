// Which robot profile a log gets: by the code's name for itself and its branch, else by signals, else the student's pick.
import { describe, expect, it } from 'vitest'
import { openWpilog } from '../src/readers/wpilog.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

const eventPin: RobotProfile = { ...offseason2026, code: { ...offseason2026.code, branch: 'event-x', sha: 'abc1234' } }
const other: RobotProfile = { ...offseason2026, name: 'other robot', codebase: 'Other', code: { repo: 'r', branch: 'main', sha: 'def5678' }, motorGroups: [], cameras: [] }
const profiles = [offseason2026, eventPin, other]
const log = (codebase: string | null, branch: string) => openWpilog(writeWpilog([
  ...(codebase === null ? [] : [{ name: '/RealMetadata/Codebase', type: 'string', records: [[0, codebase]] }]),
  { name: '/RealMetadata/GitBranch', type: 'string', records: [[0, branch]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5]] },
] as Parameters<typeof writeWpilog>[0]))

describe('choosing a robot profile', () => {
  it('the robot and branch the log names', () => {
    const { profile, choice } = chooseProfile(log('2026 Offseason', 'event-x'), profiles)
    expect(profile).toBe(eventPin)
    expect(choice.how).toBe('codebase and branch')
    // This synthetic log has almost none of the profile's signals, so the choice says the profile may need updating.
    expect(choice.note).toMatch(/may need updating/)
  })
  it('the robot the log names, pinned to main when no profile has its branch, with a note', () => {
    const { profile, choice } = chooseProfile(log('2026 Offseason', 'some-feature'), profiles)
    expect(profile).toBe(offseason2026)
    expect(choice.how).toBe('codebase')
    expect(choice.note).toMatch(/some-feature/)
  })
  it('an unknown robot gets the best fit by signals, with a warning when it fits badly', () => {
    const { choice } = chooseProfile(log('2019 Robot', 'main'), profiles)
    expect(choice.how).toBe('signals')
    expect(choice.misfit).toBe(true)
    expect(choice.note).toMatch(/"2019 Robot".*were not run/)
  })
  it('the student\'s choice wins', () => {
    const { profile, choice } = chooseProfile(log('2026 Offseason', 'event-x'), profiles, other)
    expect(profile).toBe(other)
    expect(choice.how).toBe('chosen by you')
  })
})

describe('a log no profile fits', () => {
  const log = writeWpilog([
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, true]] },
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [14, false], [28, true], [163, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, true], [28, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.6], [30, 11.5]] },
  ] as Parameters<typeof writeWpilog>[0])
  const a = analyzeFiles([{ name: 'other-robot.wpilog', bytes: log }], () => offseason2026).analyses[0]
  it('skips the rules about specific motors, devices, cameras and mechanisms, and says why', () => {
    expect(a.match.profileChoice.misfit).toBe(true)
    expect(a.report.skipped.find((s) => s.rule === 'power/limit-not-applied')?.reason).toMatch(/doesn't fit this log/)
    expect(a.report.skipped.find((s) => s.rule === 'mech/follower-mismatch')?.reason).toMatch(/doesn't fit this log/)
  })
  it('measures auto from the field timing even when the robot was disabled early in auto', () => {
    // Auto started at 10 s, teleop at 28 s: 18 s less the field's 3 s pause is a 15 s auto, though it ran only 4 s.
    expect(a.match.profile.game.autoSeconds).toBe(15)
    expect(a.match.profile.game.teleopSeconds).toBe(135)
  })
})
