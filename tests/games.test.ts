// The FRC game a log was played under (its auto and teleop lengths), by date, and the builder's draft using it.
import { describe, expect, it } from 'vitest'
import { gameFor } from '../src/profiles/games.ts'
import { seasonOf } from '../src/hub/season.ts'
import { carryConfirmations, draftProfile } from '../src/builder/draft.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { robotLog } from './helpers/hub-logs.ts'

const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

describe('gameFor', () => {
  it('is the game of the latest kickoff: an offseason log in October plays that year\'s game', () => {
    expect(gameFor(local(2025, 10, 20))).toMatchObject({ game: { name: '2025 REEFSCAPE', autoSeconds: 15, teleopSeconds: 135 }, assumed: false })
    expect(gameFor(local(2023, 3, 1))).toMatchObject({ game: { name: '2023 CHARGED UP', autoSeconds: 15, teleopSeconds: 135 } })
    expect(gameFor(local(2024, 3, 1))).toMatchObject({ game: { name: '2024 CRESCENDO', autoSeconds: 15, teleopSeconds: 135 } })
  })

  it('changes game on kickoff day, not on January 1', () => {
    expect(gameFor(local(2026, 1, 9, 23))?.game.name).toBe('2025 REEFSCAPE')
    expect(gameFor(local(2026, 1, 10, 0))).toMatchObject({ game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 }, assumed: false })
  })

  it('assumes the latest game, and says so, in a year with no kickoff listed yet', () => {
    expect(gameFor(local(2026, 12, 20))).toMatchObject({ game: { name: '2026 REBUILT' }, assumed: false })
    expect(gameFor(local(2027, 1, 15))).toMatchObject({ game: { name: '2026 REBUILT' }, assumed: true })
  })

  it('knows no game before the first kickoff listed', () => {
    expect(gameFor(local(2023, 1, 6))).toBeNull()
  })

  it('leaves the season window as it was: the season starts on kickoff day', () => {
    expect(seasonOf(local(2026, 1, 9))).toBe('off-season')
    expect(seasonOf(local(2026, 1, 10))).toBe('season')
    expect(seasonOf(local(2025, 1, 4))).toBe('season')
    expect(seasonOf(local(2024, 1, 5))).toBe('off-season')
  })
})

describe('the draft\'s game', () => {
  // A practice run: enabled 20 s, never a full match, so measuring would give a game that isn't the one played.
  const draft = (clockMs: number | undefined, fileName = 'practice.wpilog') =>
    draftProfile({ logs: [{ log: openWpilog(robotLog({ clockMs, enabled: [10, 30] })), fileName }] })

  it('is the season\'s game for a dated log, not lengths measured from a practice run', () => {
    expect(draft(Date.UTC(2026, 1, 20, 20)).json.game).toEqual({ name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 })
    expect(draft(Date.UTC(2025, 9, 20, 20)).json.game).toEqual({ name: '2025 REEFSCAPE', autoSeconds: 15, teleopSeconds: 135 })
  })

  it('takes the date from an AdvantageKit file name when the robot clock was never set', () => {
    expect(draft(undefined, 'akit_26-02-20_20-00-00.wpilog').json.game?.name).toBe('2026 REBUILT')
  })

  it('is measured, with a note saying why, when the log has no date', () => {
    const d = draft(undefined)
    expect(d.json.game?.name).toBe('measured from practice.wpilog')
    expect(d.notes.join(' ')).toMatch(/no date.*measured from this log/i)
  })

  it('says a log dated before the first kickoff listed is older than the table, not that its year is missing', () => {
    expect(draft(Date.UTC(2023, 0, 3, 20)).notes.join(' ')).toMatch(/before 2023's kickoff, the first game listed.*measured from this log/)
  })

  it('replaces a measured game with the season\'s when a dated log is dropped next', () => {
    const undated = draft(undefined).json
    const dated = draft(Date.UTC(2026, 1, 20, 20)).json
    carryConfirmations(undated, dated)
    expect(dated.game).toEqual({ name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 })
    // A season game the student kept stays.
    const again = draft(Date.UTC(2026, 1, 21, 20)).json
    carryConfirmations({ ...dated, game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 150 } }, again)
    expect(again.game?.teleopSeconds).toBe(150)
  })

  it('notes a year whose kickoff isn\'t listed yet', () => {
    const d = draft(Date.UTC(2027, 0, 20, 20))
    expect(d.json.game?.name).toBe('2026 REBUILT')
    expect(d.notes.join(' ')).toMatch(/no kickoff listed for 2027.*2026 REBUILT.*games\.ts/i)
  })
})
