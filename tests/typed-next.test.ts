// Slice 2: a next match number typed in when there is no schedule is its own timeline input, never a one-match schedule.
// Invented data (event TEST, robot "Test robot"); no real match, team or verdict.
import { describe, expect, it } from 'vitest'
import { buildBoard, deferralOptions, type BoardIssue } from '../src/board/model.ts'
import { beforePlayoffs, endOfEvent, resolveUntil, suggestions, timeline } from '../src/board/points.ts'
import { queueSheet } from '../src/board/sheets.ts'
import { parseNext, readNext, writeNext, type NextStore } from '../src/board/typed-next.ts'
import type { BoardEvent } from '../src/triage/history.ts'
import { shortMatchLabel } from '../src/ui/match-label.ts'
import { BASE, ROBOT, SCHEDULE, input, match, session } from './helpers/board-scene.ts'

const A = 'power/brownout · test'
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
let seq = 0
const bl = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: A, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const fired = (n: number) => match(n, { fires: [{ key: A, severity: 'error' }] })
const label = (m: { matchLabel: string }) => shortMatchLabel(m.matchLabel, 0)
const tlOf = (nums: number[], typed?: number | null) => timeline(session(nums.map((n) => match(n))), null, label, undefined, typed)
const board = (nums: number[], typed: number | null, history: BoardEvent[] = []) =>
  buildBoard({ ...input(session(nums.map(fired)), history, null), now: new Date(BASE + 3 * 60e3), typedNext: typed })
const issue = (b: ReturnType<typeof board>): BoardIssue => b.issues.find((i) => i.key === A)!

describe('timeline with a typed next match', () => {
  it('typed above the last qualification played: the next match, and nothing of a schedule', () => {
    const tl = tlOf([5, 6], 41)
    expect(tl.next).toEqual({ label: 'Q41', level: 'qm', number: 41, pos: 41, startsAt: null, minutes: null, leftMinutes: null })
    expect(tl.nextPos).toBe(40.5)
    expect(tl).toMatchObject({ hasSchedule: false, lastQual: null, hasPlayoffs: false, named: [], all: [], toEnd: null })
    expect(tl.last?.qual).toBe(6)
  })
  it('typed at or below the last qualification played is stale: the next match is unknown again', () => {
    for (const typed of [6, 5, 1]) {
      const tl = tlOf([5, 6], typed)
      expect(tl.next).toBeNull()
      expect(tl.nextPos).toBe(0)
      expect(tl.hasSchedule).toBe(false)
    }
    expect(tlOf([5, 6], 7).next?.label).toBe('Q7')
  })
  it('no on-field log yet (the first match of the day): the typed number is the next match', () => {
    const tl = timeline(session([]), null, label, undefined, 12)
    expect(tl.last).toBeNull()
    expect(tl.next?.label).toBe('Q12')
    expect(tl.nextPos).toBe(11.5)
    expect(timeline(session([match(3, { onField: false })]), null, label, undefined, 12).next?.label).toBe('Q12')
  })
  it('junk is ignored; a schedule wins over a typed number', () => {
    for (const bad of [0, -3, 2.5, Number.NaN, null, undefined]) expect(tlOf([5], bad).next).toBeNull()
    const withSchedule = timeline(session([match(5)]), SCHEDULE, label, undefined, 99)
    expect(withSchedule.next?.label).toBe('Q6')
  })
})

describe('the typed match is not a schedule: end-of-event and before-playoffs keep their positions', () => {
  it('the end of the event and before playoffs never name the typed match', () => {
    const tl = tlOf([5], 41)
    expect(endOfEvent(tl)).toMatchObject({ pos: 1e6, until: 'the end of the event', match: null })
    expect(beforePlayoffs(tl)).toMatchObject({ pos: 1e6 - 2, until: 'playoffs', match: null })
    const none = tlOf([5], null)
    expect(endOfEvent(tl)).toEqual(endOfEvent(none))
    expect(beforePlayoffs(tl)).toEqual(beforePlayoffs(none))
  })
  it('suggestions: the next match is named, the rest read as with no schedule', () => {
    const typed = suggestions(tlOf([5], 41))
    const none = suggestions(tlOf([5], null))
    expect(typed.map((s) => s.id)).toEqual(none.map((s) => s.id))
    expect(typed[0]).toMatchObject({ id: 'next', label: 'Next match (Q41)', until: { kind: 'next-match', match: 'Q41' } })
    expect(typed.slice(1).map((s) => [s.label, s.point.pos])).toEqual(none.slice(1).map((s) => [s.label, s.point.pos]))
  })
  it('an end-of-event or before-playoffs deferral stays open after the typed match is played', () => {
    for (const [kind, value] of [['end-of-event', 'end-of-event'], ['before-elims', 'before-elims']] as const) {
      const hist = [bl('workaround', 'test workaround', iso(1)), bl('defer', value, iso(1), { until: { kind } })]
      const before = issue(board([5], 41, hist)).deferral!
      expect(before.expired).toBe(false)
      // Q41 is typed and then its log is pulled: the typed number is stale, the deferral is still open.
      const after = issue(board([5, 41], 41, hist)).deferral!
      expect(after.expired).toBe(false)
      expect(after.point.pos).toBe(kind === 'end-of-event' ? 1e6 : 1e6 - 2)
    }
  })
})

describe('a deferral "until Q41" made with Q41 typed', () => {
  const hist = [bl('workaround', 'test workaround', iso(1)), bl('defer', 'next-match', iso(1), { until: { kind: 'next-match', match: 'Q41' } })]
  it('is open until Q41\'s own log is in, then over (not at the moment the typed number goes stale before that)', () => {
    expect(issue(board([5], 41, hist)).deferral).toMatchObject({ expired: false, point: { pos: 40.5, until: 'Q41' } })
    expect(issue(board([5, 6], 41, hist)).deferral!.expired).toBe(false)
    expect(issue(board([5, 6, 41], 41, hist)).deferral!.expired).toBe(true)
    expect(issue(board([5, 6, 41], null, hist)).deferral!.expired).toBe(true)
  })
  it('the deferral the dialog offers names the typed match and expires the same way', () => {
    const b = board([5], 41)
    const pick = deferralOptions(b, { priority: 'red' }).find((s) => s.id === 'next')!
    expect(pick.until).toEqual({ kind: 'next-match', match: 'Q41' })
    expect(resolveUntil(pick.until, b.tl).pos).toBe(40.5)
  })
  it('an unnamed next-match deferral made before anything was typed ends once a later match is played', () => {
    const h = [bl('workaround', 'test workaround', iso(105)), bl('defer', 'next-match', iso(105), { until: { kind: 'next-match' }, match: 'Q5' })]
    expect(issue(board([5], 41, h)).deferral!.expired).toBe(false)
    expect(issue(board([5, 41], 41, h)).deferral!.expired).toBe(true)
  })
})

describe('gate, due points and the queue sheet name the typed match', () => {
  it('a red is due before the typed match; the sheet and ticks use Q41', () => {
    const b = board([5], 41)
    expect(issue(b).due).toMatchObject({ text: 'before Q41', pos: 40.5, match: 'Q41' })
    expect(b.strip).toMatchObject({ gate: 1, nextLabel: 'Q41', over: false })
    expect(b.tickFor).toBe('Q41')
    const sheet = queueSheet(b)
    expect([sheet.forMatch, sheet.forLabel, sheet.when]).toEqual(['Q41', 'Q41', 'before Q41'])
  })
  it('stale: the sheet reads as with no number typed', () => {
    const [stale, none] = [queueSheet(board([5, 41], 41)), queueSheet(board([5, 41], null))]
    expect(stale).toEqual(none)
    expect(stale.forLabel).toBe('the next match')
  })
  it('nothing typed and nothing stale: the board is byte-for-byte the board without the input', () => {
    const [a, b] = [board([5], null), buildBoard({ ...input(session([fired(5)]), [], null), now: new Date(BASE + 3 * 60e3) })]
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('typed-next.ts', () => {
  const mem = (init: Record<string, string> = {}): NextStore & { m: Map<string, string> } => {
    const m = new Map(Object.entries(init))
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
  }
  it('reads "41", "Q41", " q 41 "; refuses the rest', () => {
    expect([parseNext('41'), parseNext('Q41'), parseNext(' q 41 '), parseNext('q7')]).toEqual([41, 41, 41, 7])
    for (const bad of ['', 'Q', '0', '1.5', '-2', 'SF1M1', '41 42', 'Q41x', '1234']) expect(parseNext(bad)).toBeNull()
  })
  it('keeps a number per event, and forgets it on null', () => {
    const s = mem()
    expect(writeNext(s, 'TEST', 41)).toBe(true)
    expect(writeNext(s, 'OTHER', 9)).toBe(true)
    expect(readNext(s, ['TEST'])).toBe(41)
    expect(readNext(s, ['OTHER'])).toBe(9)
    expect(readNext(s, ['NONE'])).toBeNull()
    expect(readNext(s, ['NONE', 'TEST'])).toBe(41)
    writeNext(s, 'TEST', null)
    expect(readNext(s, ['TEST'])).toBeNull()
  })
  it('a missing, throwing or corrupt store gives null / false, never an error', () => {
    expect(readNext(null, ['TEST'])).toBeNull()
    expect(writeNext(null, 'TEST', 4)).toBe(false)
    const bad: NextStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('denied') } }
    expect(readNext(bad, ['TEST'])).toBeNull()
    expect(writeNext(bad, 'TEST', 4)).toBe(false)
    expect(readNext(mem({ 'hindsight.nextMatch.TEST': 'junk' }), ['TEST'])).toBeNull()
  })
})
