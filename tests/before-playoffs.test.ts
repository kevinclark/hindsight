// Slice 16b: "Before playoffs" with no schedule stays offered until a playoff log has been seen.
// Everything here is invented (event TEST, "test workaround"); no real match, team or verdict.
import { describe, expect, it } from 'vitest'
import { buildBoard, deferralOptions } from '../src/board/model.ts'
import { suggestions, timeline } from '../src/board/points.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import type { BoardEvent, EventNote } from '../src/triage/history.ts'
import { shortMatchLabel } from '../src/ui/match-label.ts'
import { BASE, ROBOT, SCHEDULE, input, match, session } from './helpers/board-scene.ts'

const KEY = 'power/brownout · test'
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
let seq = 0
const bl = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: KEY, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const cut = (text: string, when: string): EventNote => ({ type: 'event-note', v: 1, kind: 'cut-off', event: 'TEST', match: 'Q5', text, by: { device: 'dev-a', role: 'software' }, seq: ++seq, when })
const fired = (n: number) => match(n, { fires: [{ key: KEY, severity: 'error' }] })
const playoff = (n: number): MatchSummary => ({ ...match(n), matchLabel: `Elimination ${n}`, matchType: 3 })
const label = (m: MatchSummary) => shortMatchLabel(m.matchLabel, 0)

describe('"Before playoffs" with no schedule', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
  it('stays offered after an "after Qn" cut-off until a playoff log has been seen', () => {
    const history = [cut('Q5', iso(1))]
    const none = buildBoard({ ...input(session([fired(5)]), history, null), now: new Date(BASE + 905 * 60e3) })
    expect(none.cutOff).toMatchObject({ passed: true, playoffSeen: false })
    expect(ids(deferralOptions(none, { priority: 'red' }))).toContain('playoffs')
    expect(ids(deferralOptions(none, { priority: 'amber' }))).toContain('playoffs')
    const seen = buildBoard({ ...input(session([fired(5), playoff(1)]), history, null), now: new Date(BASE + 905 * 60e3) })
    expect(seen.cutOff.playoffSeen).toBe(true)
    for (const priority of ['red', 'amber'] as const) expect(ids(deferralOptions(seen, { priority }))).not.toContain('playoffs')
  })
  it('suggestions: the playoff fact decides when there is no schedule; a schedule still decides by position', () => {
    const tl = timeline(session([match(5)]), null, label)
    for (const red of [true, false]) {
      expect(ids(suggestions(tl, { passed: true, red, playoffSeen: false }))).toContain('playoffs')
      expect(ids(suggestions(tl, { passed: true, red }))).toContain('playoffs')
      expect(ids(suggestions(tl, { passed: true, red, playoffSeen: true }))).not.toContain('playoffs')
    }
    const late = timeline(session([match(40), match(41)]), SCHEDULE, label)
    expect(ids(suggestions(late, { passed: true, red: true, playoffSeen: false }))).not.toContain('playoffs')
  })
})
