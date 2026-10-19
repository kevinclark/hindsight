// The event view: grouping, confidence, the merged findings and the session file.
import { describe, expect, it } from 'vitest'
import { confidence, dateText, groupSessions, mergeFindings, ruleGrid, wilson } from '../src/session/session.ts'
import { dateFromFileName, summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import { buildSessionJson } from '../src/session/export.ts'
import { writeWpilog } from './helpers/fixture-format.ts'
import { CALGAMES, haveCalGames, readInput } from './helpers/load.ts'

describe('confidence in words', () => {
  it.each([
    [3, 3, 'consistent'], [2, 3, 'consistent'], [1, 3, 'once'], [2, 5, 'intermittent'], [2, 2, 'intermittent'],
    [1, 1, 'not enough data'], [0, 4, 'quiet'],
  ] as const)('%i of %i is %s', (k, n, words) => expect(confidence(k, n)).toBe(words))
  it('Wilson interval: 3 of 3 is 44–100 %, 1 of 3 is 6–79 %', () => {
    expect(wilson(3, 3).map((x) => +x.toFixed(2))).toEqual([0.44, 1])
    expect(wilson(1, 3).map((x) => +x.toFixed(2))).toEqual([0.06, 0.79])
  })
})

describe('dates and grouping', () => {
  it('reads the date from an AdvantageKit file name', () => {
    expect(new Date(dateFromFileName('akit_26-02-14_18-03-07_practice.wpilog')!).toISOString()).toBe('2026-02-14T18:03:07.000Z')
    expect(dateFromFileName('Log_2.wpilog')).toBeNull()
  })
  const unset = (name: string) => summarizeLog({ name, bytes: writeWpilog([
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [40, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, false]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[10, true]] },
    // An unset roboRIO clock: late 2024.
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[10, Date.UTC(2024, 11, 18) * 1000], [40, Date.UTC(2024, 11, 18) * 1000 + 30e6]] },
  ]) })!
  it('an unset robot clock falls back to the file name, with a note', () => {
    const s = unset('akit_26-02-14_18-03-07.wpilog')
    expect(s.playedAtSource).toBe('file name')
    expect(s.clockNote).toMatch(/robot clock was not set/)
    expect(dateText(s.playedAt!)).toBe(dateText(Date.UTC(2026, 1, 14, 18, 3, 7)))
  })
  it('no clock and no date in the name: an "undated" session, to be grouped by hand', () => {
    const s = unset('Log_2.wpilog')
    expect(s.playedAt).toBeNull()
    expect(groupSessions([s])[0]).toMatchObject({ kind: 'undated', label: 'Logs with no date' })
    expect(groupSessions([s], { 'Log_2.wpilog': 'Bench tests' })[0].label).toBe('Bench tests')
  })
  it('practice logs on the same day share a session; events with one name within 4 days share one', () => {
    const m = (fileName: string, playedAt: number, onField = false, event = '') => ({ fileName, playedAt, onField, event, rules: {} } as unknown as MatchSummary)
    const day = Date.UTC(2026, 1, 14, 18)
    const sessions = groupSessions([m('a', day), m('b', day + 3600e3), m('c', day + 86400e3), m('d', day + 2 * 86400e3, true, 'casf'), m('e', day + 4 * 86400e3, true, 'casf')])
    expect(sessions.map((s) => s.matches.length)).toEqual([2, 1, 2])
  })
})

if (!haveCalGames) console.warn('SKIPPED session checks on the CalGames logs (not in ~/Downloads)')

describe.skipIf(!haveCalGames)('the three CalGames logs as one session', () => {
  const summaries = haveCalGames ? [CALGAMES.q13, CALGAMES.q21, CALGAMES.p0].map((p) => summarizeLog(readInput(p))!) : []
  const sessions = groupSessions(summaries)
  it('group into one event session', () => {
    expect(sessions).toHaveLength(1)
    expect(sessions[0].kind).toBe('event')
    expect(sessions[0].matches).toHaveLength(3)
  })
  it('follower mismatch is consistent, 3 of 3; brownout is once, 1 of 3', () => {
    const grid = ruleGrid(sessions[0])
    expect(grid.find((r) => r.rule === 'mech/follower-mismatch')).toMatchObject({ fired: 3, checkable: 3, confidence: 'consistent' })
    expect(grid.find((r) => r.rule === 'power/brownout')).toMatchObject({ fired: 1, checkable: 3, confidence: 'once' })
  })
  it('the follower finding merges into one row with the median speed range (93–97 % of the leader)', () => {
    const f = mergeFindings(sessions[0]).find((x) => x.key === 'mech/follower-mismatch · Flywheel')!
    expect(f.matches).toHaveLength(3)
    const speed = f.measured.find((m) => m.label.includes('median speed'))!
    expect([speed.min, speed.max]).toEqual([93, 97])
  })
  it('a pre-match alert is context, not a finding that fired in the match', () => {
    const f = mergeFindings(sessions[0]).find((x) => x.key === 'alerts/passthrough · Back_Right Camera Disconnected!')
    expect(f?.matches).toHaveLength(1) // only Q21 lost the camera during the match
  })
  it('session-findings.json is small and carries no raw series or radio status', () => {
    const text = JSON.stringify(buildSessionJson(sessions[0]))
    expect(text.length).toBeLessThan(500_000)
    expect(text).not.toMatch(/RadioStatus/)
  })
})
