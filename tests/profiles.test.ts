// Which robot profile a log gets: by the code's name for itself and its branch, else by signals, else the student's pick.
import { describe, expect, it } from 'vitest'
import { openWpilog } from '../src/readers/wpilog.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { chooseProfile, robotName } from '../src/profiles/choose.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { competition2026 } from '../src/profiles/2026-competition.ts'
import { PROFILES } from '../src/profiles/index.ts'
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
  it('an unknown robot that fits no profile is flagged a misfit, and says why', () => {
    const { choice } = chooseProfile(log('2019 Robot', 'main'), profiles)
    expect(choice.how).toBe('signals')
    expect(choice.misfit).toBe(true)
    expect(choice.note).toMatch(/"2019 Robot".*were not run/)
  })
  it('a profile no log fits is not applied: the log is read with its own standard signals (Kevin, 2026-10-23)', () => {
    const { profile, choice } = chooseProfile(log('2019 Robot', 'main'), profiles)
    expect(profiles).not.toContain(profile)
    expect(profile.motorGroups).toEqual([])
    expect(profile.cameras).toEqual([])
    expect(profile.name).toBe('2019 Robot (code name)')
    expect(profile.code).toEqual({ repo: '', branch: 'main', sha: '' })
    expect(profile.signals.batteryVoltage).toBe('/SystemStats/BatteryVoltage')
    expect(choice.note).toMatch(/none fits it \(the closest, ".*", has \d+ of its \d+ signals in this log\)/)
  })
  it('a best guess that fits badly is named by the log\'s own code name, not the profile (as in the library)', () => {
    const { profile, choice } = chooseProfile(log('2019 Robot', 'main'), profiles)
    expect(robotName(profile.name, choice)).toBe('2019 Robot (code name)')
    expect(robotName(profile.name, { how: 'signals', misfit: true })).toBe('unnamed robot')
    const named = chooseProfile(log('2026 Offseason', 'event-x'), profiles)
    expect(robotName(named.profile.name, named.choice)).toBe(named.profile.name)
  })
  it('the student\'s choice wins', () => {
    const { profile, choice } = chooseProfile(log('2026 Offseason', 'event-x'), profiles, other)
    expect(profile).toBe(other)
    expect(choice.how).toBe('chosen by you')
  })
})

describe('a log no profile fits, read with its own signals', () => {
  it('leaves out a signal the builder would ask a person to pick among several candidates', () => {
    const twoChoosers = openWpilog(writeWpilog([
      { name: '/RealMetadata/Codebase', type: 'string', records: [[0, '2019 Robot']] },
      { name: '/DashboardInputs/Auto Chooser', type: 'string', records: [[0, 'none']] },
      { name: '/DashboardInputs/Choreo Auto Chooser', type: 'string', records: [[0, '3 Blue Clear']] },
    ] as Parameters<typeof writeWpilog>[0]))
    expect(chooseProfile(twoChoosers, profiles).profile.signals.autoChoice).toBe('')
    const oneChooser = openWpilog(writeWpilog([
      { name: '/RealMetadata/Codebase', type: 'string', records: [[0, '2019 Robot']] },
      { name: '/DashboardInputs/Auto Chooser', type: 'string', records: [[0, 'Source 3']] },
    ] as Parameters<typeof writeWpilog>[0]))
    expect(chooseProfile(oneChooser, profiles).profile.signals.autoChoice).toBe('/DashboardInputs/Auto Chooser')
  })
})

describe('the built-in profiles', () => {
  it('a 2026 competition robot log gets its profile, on either bring-up branch', () => {
    for (const branch of ['comp-bring-up', 'comp-bring-up-2-21']) {
      const { profile, choice } = chooseProfile(log('Rebuilt', branch), PROFILES)
      expect(profile).toBe(competition2026)
      expect(choice.how).toBe('codebase and branch')
    }
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
