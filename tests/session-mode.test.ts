// The mode line (ADR 3): worded for every view, changed per session, and kept with the renames. Invented logs only.
import { describe, expect, it } from 'vitest'
import { groupSessions } from '../src/session/session.ts'
import { applyMode, logModeLine, loneLogMode, modeChoice, modeLine, modeOf, todayMode, withModeChoice } from '../src/session/mode.ts'
import type { MatchSummary } from '../src/session/summary.ts'

const log = (fileName: string, playedAt: number, over: Partial<MatchSummary> = {}) => ({ fileName, playedAt, onField: false, event: '', matchLabel: '', matchType: 0, rules: {}, ...over } as unknown as MatchSummary)
const day = Date.UTC(2025, 6, 12, 18)
// An event day with two qualification matches and a pit run, and a practice day a week later.
const logs = [
  log('q1', day, { onField: true, event: 'TEST', matchLabel: 'Qualification 1', matchType: 2 }),
  log('pit', day + 3600e3),
  log('q2', day + 7200e3, { onField: true, event: 'TEST', matchLabel: 'Qualification 2', matchType: 2 }),
  log('p1', day + 7 * 86400e3), log('p2', day + 7 * 86400e3 + 600e3),
]

describe('the mode line', () => {
  const [event, practice] = groupSessions(logs)
  it('an event says what the field data said', () => {
    expect(modeLine(event)).toBe('Event · TEST · qualification (from the field data)')
    expect(event.mode).toBe('event')
  })
  it('a practice day says its date', () => {
    expect(modeLine(practice)).toMatch(/^Practice · 2025-07-(19|20)$/)
  })
  it('a pit run says so, any other log gets its session line', () => {
    expect(logModeLine(event, 'pit')).toBe('Event · pit run on an event day')
    expect(logModeLine(event, 'q1')).toBe(modeLine(event))
    expect(logModeLine(practice, 'p1')).toBe(modeLine(practice))
  })
  it('the field data names qualification and elimination together', () => {
    const [s] = groupSessions([log('a', day, { onField: true, event: 'TEST', matchType: 2 }), log('b', day + 1000, { onField: true, event: 'TEST', matchType: 3 })])
    expect(modeLine(s)).toBe('Event · TEST · qualification and elimination (from the field data)')
  })
})

describe('changing the mode for one session', () => {
  const store = (id: string, mode: 'event' | 'practice') => withModeChoice({}, id, mode)
  it('the choice lives beside the renames and never reads as a rename', () => {
    const s = withModeChoice({ 'practice:2025-07-19': 'Shop day' }, 'event:TEST:2025-07-12', 'practice')
    expect(s).toEqual({ 'practice:2025-07-19': 'Shop day', 'mode:event:TEST:2025-07-12': 'practice' })
    expect(modeChoice(s, 'event:TEST:2025-07-12')).toBe('practice')
    expect(modeChoice(s, 'practice:2025-07-19')).toBeNull()
    expect(withModeChoice(s, 'event:TEST:2025-07-12', null)).toEqual({ 'practice:2025-07-19': 'Shop day' })
    expect(modeChoice({ 'mode:x': 'nonsense' }, 'x')).toBeNull()
  })
  it('an event set to practice treats every log as a run: the pit runs join its logs', () => {
    const id = groupSessions(logs)[0].id
    const [s] = groupSessions(logs, {}, store(id, 'practice'))
    expect(s.kind).toBe('event')
    expect(modeOf(s)).toBe('practice')
    expect(s.matches.map((m) => m.fileName)).toEqual(['q1', 'pit', 'q2'])
    expect(s.pitRuns).toBeUndefined()
    expect(modeLine(s)).toBe('Practice · 2025-07-12 (set by hand)')
  })
  it('a practice day set to event: on-field logs are matches, the rest pit runs', () => {
    const id = groupSessions(logs)[1].id
    const [, s] = groupSessions(logs, {}, store(id, 'event'))
    expect(modeOf(s)).toBe('event')
    expect(s.matches).toEqual([])
    expect(s.pitRuns!.map((m) => m.fileName)).toEqual(['p1', 'p2'])
    expect(modeLine(s)).toMatch(/^Event · Practice 2025-07-(19|20) \(set by hand\)$/)
  })
  it('a choice equal to the inferred mode still says it was set by hand; automatic clears it', () => {
    const id = groupSessions(logs)[0].id
    const [s] = groupSessions(logs, {}, store(id, 'event'))
    expect(s.modeByHand).toBe(true)
    expect(modeLine(s)).toMatch(/\(set by hand\)$/)
    expect(groupSessions(logs, {}, withModeChoice(store(id, 'event'), id, null))[0].modeByHand).toBe(false)
  })
  it('applyMode on a session without pit runs does nothing to a practice day set to practice', () => {
    const [, s] = groupSessions(logs)
    const before = s.matches.length
    applyMode(s, 'practice')
    expect(s.matches.length).toBe(before)
  })
})

describe('a log nothing has grouped, and Foresight', () => {
  it('a lone on-field log is an event, a lone off-field log is practice', () => {
    expect(loneLogMode({ onField: true, event: 'TEST', matchLabel: 'Qualification 1', playedAt: day }).line).toBe('Event · TEST · Qualification 1 (from the field data; this log alone)')
    const lone = loneLogMode({ onField: false, event: '', matchLabel: '', playedAt: day })
    expect(lone.line).toBe('Practice · 2025-07-12 (this log alone)')
    expect(lone.sessionId).toBe('practice:2025-07-12')
    expect(loneLogMode({ onField: false, event: '', matchLabel: '', playedAt: day }, withModeChoice({}, lone.sessionId, 'event')).line).toBe('Event · this log (set by hand; this log alone)')
  })
  it('Foresight on an event day is a pit run; elsewhere practice with the laptop day', () => {
    const sessions = groupSessions(logs)
    expect(todayMode(sessions, day + 1000).line).toBe('Event · pit run on an event day')
    expect(todayMode(sessions, day + 3 * 86400e3)).toMatchObject({ line: 'Practice · 2025-07-15', mode: 'practice', sessionId: 'practice:2025-07-15' })
    expect(todayMode([], day).line).toBe('Practice · 2025-07-12')
    expect(todayMode(sessions, day + 1000, withModeChoice({}, sessions[0].id, 'practice'))).toMatchObject({ line: 'Practice · 2025-07-12 (set by hand)', byHand: true })
  })
})
