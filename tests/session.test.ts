// The event view: grouping, confidence, the merged findings and the session file.
import { describe, expect, it } from 'vitest'
import { confidence, dateText, groupSessions, mergeFindings, ruleGrid, standingKeys, wilson } from '../src/session/session.ts'
import { dateFromFileName, summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import { buildSessionJson } from '../src/session/export.ts'
import { writeWpilog } from './helpers/fixture-format.ts'
import { LOGS, haveLogs, readInput } from './helpers/load.ts'

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
  it('on-field matches with no event name still make one event; a match split across logs counts once', () => {
    const metrics = { minVolts: 8, secondsUnder7: 0, chargeAh: 1, resistanceMilliohms: null, followerSecondsOff: null, brownoutVolts: 6, loopOverrunPct: 5, visionOutlierPct: null }
    const fit = { profileId: 'p @ main', name: 'p', code: { repo: 'r', branch: 'main', sha: 'abc1234' }, how: 'signals', note: null, present: 40, total: 90 }
    const m = (fileName: string, playedAt: number, matchLabel: string, fired: boolean) => ({
      fileName, fileSize: 1, playedAt, onField: true, event: '', matchLabel, batteryId: null, clockNote: null, problems: [], robot: fit,
      timing: { parseMs: 1, rulesMs: 1 }, metrics: { ...metrics, minVolts: fired ? 6 : 8 },
      rules: { 'comms/loss': { status: fired ? 'fired' : 'quiet', findings: fired ? [{ key: 'comms/loss', rule: 'comms/loss', severity: 'warning', title: matchLabel }] : [] }, 'loop/overrun': { status: 'fired', findings: [{ key: 'loop/overrun', rule: 'loop/overrun', severity: 'warning', title: fileName }] } },
    } as unknown as MatchSummary)
    const day = Date.UTC(2025, 10, 8, 18)
    const sessions = groupSessions([
      m('q27', day, 'Qualification 27', false),
      m('q28a', day + 3600e3, 'Qualification 28', false), m('q28b', day + 3700e3, 'Qualification 28', true), m('q28c', day + 3800e3, 'Qualification 28', false),
      m('q61', day + 86400e3, 'Qualification 61', false),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].label).toMatch(/no event name logged/)
    expect(sessions[0].matches.map((x) => x.matchLabel)).toEqual(['Qualification 27', 'Qualification 28', 'Qualification 61'])
    const q28 = sessions[0].matches[1]
    expect(q28.pieces).toEqual(['q28a', 'q28b', 'q28c'])
    expect(q28.rules['comms/loss'].status).toBe('fired')
    expect(q28.metrics.minVolts).toBe(6)
    expect(q28.metrics.chargeAh).toBe(3)
    // The same issue in three pieces is one finding for the match.
    expect(q28.rules['loop/overrun'].findings).toHaveLength(1)
    // A restart piece dated by its log start, up to ~12 min before the match, still joins.
    const late = groupSessions([m('q5a', day, 'Qualification 5', false), m('q5b', day + 20 * 60e3, 'Qualification 5', false)])
    expect(late[0].matches).toHaveLength(1)
  })
})

if (!haveLogs) console.warn('SKIPPED session checks on the team\'s logs A, B and C (not listed in tests/helpers/team-logs.ts)')

describe.skipIf(!haveLogs)('the team\'s logs A, B and C as one session', () => {
  const summaries = haveLogs ? [LOGS.a, LOGS.b, LOGS.c].map((p) => summarizeLog(readInput(p))!) : []
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
    expect(f?.matches).toHaveLength(1) // only B lost the camera during the match
  })
  it('session-findings.json is small and carries no raw series or radio status', () => {
    const text = JSON.stringify(buildSessionJson(sessions[0]))
    expect(text.length).toBeLessThan(500_000)
    expect(text).not.toMatch(/RadioStatus/)
  })
})

describe('standingKeys: issues that fired in every match where they could be checked', () => {
  type St = 'fired' | 'quiet' | 'not checked'
  const fnd = (key: string, rule: string, severity = 'warning') => ({ key, rule, severity, title: key })
  /** One match: per rule, a status and the keys that fired (an info finding when the key is prefixed "info:"). */
  const match = (name: string, rules: Record<string, [St, string[]]>) => ({
    fileName: name, playedAt: 1,
    rules: Object.fromEntries(Object.entries(rules).map(([rule, [status, keys]]) => [rule, {
      status, findings: keys.map((k) => (k.startsWith('info:') ? fnd(k.slice(5), rule, 'info') : fnd(k, rule))),
    }])),
  }) as unknown as MatchSummary
  const session = (matches: MatchSummary[]) => ({ id: 's', label: 's', kind: 'event' as const, matches })
  const fired = (n: string) => match(n, { 'loop/overrun': ['fired', ['loop/overrun']] })

  it('every match, not most: fired in 3 of 4 checkable is consistent but not standing', () => {
    const s = session([
      match('a', { 'loop/overrun': ['fired', ['loop/overrun']], 'comms/loss': ['fired', ['comms/loss']] }),
      match('b', { 'loop/overrun': ['fired', ['loop/overrun']], 'comms/loss': ['fired', ['comms/loss']] }),
      match('c', { 'loop/overrun': ['fired', ['loop/overrun']], 'comms/loss': ['fired', ['comms/loss']] }),
      match('d', { 'loop/overrun': ['fired', ['loop/overrun']], 'comms/loss': ['quiet', []] }),
    ])
    expect(mergeFindings(s).find((f) => f.key === 'comms/loss')!.confidence).toBe('consistent')
    expect([...standingKeys(s)]).toEqual(['loop/overrun'])
  })
  it('fewer than 3 checkable matches: none, even when it fired in all of them', () => {
    expect(standingKeys(session([fired('a'), fired('b')])).size).toBe(0)
    // Three matches, but the rule could be checked in only two of them.
    expect(standingKeys(session([fired('a'), fired('b'), match('c', { 'loop/overrun': ['not checked', []] })])).size).toBe(0)
  })
  it('a match where the rule could not be checked is left out of "every match"; one where it ran and was quiet breaks it', () => {
    expect([...standingKeys(session([fired('a'), fired('b'), fired('c'), match('d', { 'loop/overrun': ['not checked', []] })]))]).toEqual(['loop/overrun'])
    expect(standingKeys(session([fired('a'), fired('b'), fired('c'), match('d', { 'loop/overrun': ['quiet', []] })])).size).toBe(0)
  })
  it('a rule that ran only partly counts as checkable (summary.ts keeps it quiet/fired, not "not checked")', () => {
    // Two matches fired; the third ran the rule partly and saw nothing: checkable (3), fired in 2, so not standing.
    const partly = match('c', { 'loop/overrun': ['quiet', []] })
    expect(mergeFindings(session([fired('a'), fired('b'), partly]))[0].checkable).toBe(3)
    expect(standingKeys(session([fired('a'), fired('b'), partly])).size).toBe(0)
  })
  it('the same rule firing about something else does not count for this key; info findings never count', () => {
    const s = session([
      match('a', { 'vision/stale': ['fired', ['vision/stale · A']] }),
      match('b', { 'vision/stale': ['fired', ['vision/stale · B']] }),
      match('c', { 'vision/stale': ['fired', ['vision/stale · A']] }),
      match('d', { 'power/margin': ['quiet', ['info:power/margin']] }),
      match('e', { 'power/margin': ['quiet', ['info:power/margin']] }),
      match('f', { 'power/margin': ['quiet', ['info:power/margin']] }),
    ])
    expect(standingKeys(s).size).toBe(0)
  })
})
