// The issue board's model (slice 10, commit A): issues, priority, status, closed, due points, classes and order, the red cap, grey,
// deferral suggestions, the queue sheet and the handoff. Everything here is invented (event TEST, robot "Test robot").
import { describe, expect, it } from 'vitest'
import { buildBoard, isGate, mechanismOf, ruleRates, RED_CAP, type BoardIssue } from '../src/board/model.ts'
import { dueByPriority, durText, readUntil, resolveUntil, suggestions, timeline } from '../src/board/points.ts'
import { handoff, queueSheet, SHEET_LINES } from '../src/board/sheets.ts'
import { atLatest, boardLines, deferChanges, greyClose, greyTake, noteLine } from '../src/board/writes.ts'
import type { BoardEvent, EventNote, HistoryEvent, IssueEvent } from '../src/triage/history.ts'
import { BASE, ROBOT, SCHEDULE, input, match, profile, session, type Fire } from './helpers/board-scene.ts'
import { shortMatchLabel } from '../src/ui/match-label.ts'

const A = 'mech/follower-mismatch · Flywheel left'
const B = 'can/device-dropout · Gyro'
const C = 'comms/loss'
const D = 'power/brownout'
const E = 'vision/stale · Front camera'
const F = 'loop/overrun'
const G = 'power/margin'
const rule = (k: string) => k.split(' · ')[0]

/** Matches Q2..Q5 with the given keys firing in each (by match number); every rule in the scene is quiet where it does not fire. */
function scene(spec: Record<number, (string | Fire)[]>, opts: { pit?: Record<string, (string | Fire)[]>; robots?: Record<number, string>; notChecked?: Record<number, string[]>; upto?: number } = {}) {
  const fire = (x: string | Fire): Fire => (typeof x === 'string' ? { key: x, severity: x === C || x === G || x === F || x === E ? 'warning' : 'error' } : x)
  const all = [...new Set([...Object.values(spec).flat(), ...Object.values(opts.pit ?? {}).flat()].map((x) => rule(fire(x).key)))]
  const make = (n: number, fires: (string | Fire)[], extra: Parameters<typeof match>[1] = {}) => {
    const fs = fires.map(fire)
    return match(n, { fires: fs, quiet: all.filter((r) => !fs.some((f) => rule(f.key) === r)), robot: opts.robots?.[n], ...extra })
  }
  const nums = [2, 3, 4, 5].filter((n) => n <= (opts.upto ?? 5))
  const matches = nums.map((n) => make(n, spec[n] ?? [], { notChecked: opts.notChecked?.[n] }))
  const pit = Object.entries(opts.pit ?? {}).map(([min, fires]) => make(99, fires, { onField: false, offsetMin: Number(min), label: `pit${min}` }))
  return session(matches, pit)
}

let seq = 0
const bl = (key: string, op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key, robot: ROBOT, op, value, by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const note = (kind: EventNote['kind'], text: string, match: string, when: string, o: Partial<EventNote> = {}): EventNote => ({
  type: 'event-note', v: 1, kind, event: 'TEST', match, text, by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
/** A moment just after match n is played (match n is played at n * 20 minutes after BASE). */
const after = (n: number) => iso(n * 20 + 5)
const ref = (n: number) => ({ match: `TEST Qualification ${n}`, event: 'TEST', played: iso(n * 20) })
const byKey = (b: ReturnType<typeof buildBoard>, k: string): BoardIssue => b.issues.find((i) => i.key === k)!

describe('where the team is in the schedule', () => {
  const s = scene({ 5: [D] })
  it('the next match is the team\'s first scheduled one after the latest on-field log, with the minutes to it', () => {
    const tl = timeline(s, SCHEDULE, (m) => shortMatchLabel(m.matchLabel, 0))
    expect(tl.last).toMatchObject({ label: 'Q5', qual: 5 })
    expect(tl.next).toMatchObject({ label: 'Q6', number: 6, minutes: 55 })
    expect(tl.nextPos).toBe(5.5)
    expect(tl.named.map((g) => [g.after, g.name])).toEqual([[7, 'overnight'], [41, 'before playoffs']])
    expect(tl.lastQual).toBe(41)
  })
  it('a match The Blue Alliance has an actual time for is not next', () => {
    const played = SCHEDULE.map((m) => (m.number === 6 && m.level === 'qm' ? { ...m, actual: BASE + 1 } : m))
    expect(timeline(s, played, (m) => m.matchLabel).next?.label).toBe('Q7')
  })
  it('a latest log that is not a qualification places the team by time', () => {
    const practice = session([match(5, { label: 'pr', offsetMin: 120 }), { ...match(5, { label: 'pr2', offsetMin: 120 }), matchLabel: 'Practice 1' }])
    const tl = timeline(practice, SCHEDULE, (m) => m.matchLabel)
    expect(tl.next?.label).toBe('Q4')
  })
  it('no schedule: no next match, and the due points say so in words', () => {
    const tl = timeline(s, null, () => 'Q5')
    expect(tl.hasSchedule).toBe(false)
    expect(tl.next).toBeNull()
    expect(dueByPriority('red', tl).text).toBe('before the next match')
    expect(dueByPriority('amber', tl).text).toBe('the end of the event')
    expect(dueByPriority('low', tl).text).toBe('the end of the event')
  })
})

describe('due points (a judgment: the mock invented them)', () => {
  const tl = timeline(scene({ 5: [D] }), SCHEDULE, (m) => shortMatchLabel(m.matchLabel, 0))
  it('a red is due before the next match', () => expect(dueByPriority('red', tl)).toMatchObject({ pos: 5.5, text: 'before Q6' }))
  it('an amber is due at the next named gap after the next match', () => expect(dueByPriority('amber', tl)).toMatchObject({ pos: 7.5, text: 'after Q7 (overnight)' }))
  it('an amber with no named gap left is due at the end of the event, as a low always is', () => {
    const late = timeline(session([match(40, { offsetMin: 100 }), match(41)]), SCHEDULE, () => 'Q41')
    expect(late.named).toEqual([])
    expect(dueByPriority('amber', late).text).toBe('the end of the event')
    expect(dueByPriority('low', tl)).toMatchObject({ pos: 1e6, text: 'the end of the event' })
  })
})

describe('reading a stored deferral target', () => {
  const tl = timeline(scene({ 5: [D] }), SCHEDULE, (m) => shortMatchLabel(m.matchLabel, 0))
  it('type-checks match, matches and minutes, and drops a value of the wrong type', () => {
    expect(readUntil({ kind: 'gap', match: 5 as never, matches: '3' as never, minutes: -1 })).toEqual({ kind: 'gap' })
    expect(readUntil({ kind: 'gap', match: 'Q7', matches: 2, minutes: 30 })).toEqual({ kind: 'gap', match: 'Q7', matches: 2, minutes: 30 })
    expect(readUntil({ kind: 'gap', minutes: Infinity })).toEqual({ kind: 'gap' })
  })
  it('names the point from the match it carries, or finds the first long enough gap after the next match', () => {
    expect(resolveUntil({ kind: 'next-match', match: 'TEST Q9' }, tl)).toMatchObject({ pos: 8.5, until: 'Q9' })
    expect(resolveUntil({ kind: 'gap', match: 'Q7' }, tl)).toMatchObject({ pos: 7.5, text: 'after Q7 (overnight)', redecide: 'in that gap' })
    expect(resolveUntil({ kind: 'gap', minutes: 600 }, tl).text).toBe('after Q7 (overnight)')
    expect(resolveUntil({ kind: 'gap', matches: 30 }, tl).text).toBe('after Q7 (overnight)')
    expect(resolveUntil({ kind: 'gap', match: 7 as never }, tl).text).toMatch(/no schedule to place it|after Q7/)
    expect(resolveUntil({ kind: 'before-elims' }, tl)).toMatchObject({ pos: 41.5, text: 'before playoffs' })
    expect(resolveUntil({ kind: 'end-of-event' }, tl).pos).toBe(1e6)
    expect(resolveUntil({ kind: 'next-event' }, tl).pos).toBe(1e7)
  })
})

describe('deferral suggestions (ADR 6)', () => {
  it('with a schedule: next match, the named gaps, before playoffs, end of event, next event, each with its estimate; a red is offered the next named gap', () => {
    const tl = timeline(scene({ 5: [D] }), SCHEDULE, (m) => shortMatchLabel(m.matchLabel, 0))
    const s = suggestions(tl)
    expect(s.map((x) => x.label)).toEqual(['Next match (Q6)', 'The gap after Q7 (overnight)', 'Before playoffs (after Q41)', 'End of the event (after Q41)', 'Next event'])
    expect(s.map((x) => x.estimate)).toEqual(['≈ 55 min, est.', `≈ ${durText(24 * 60 - 60 + 600 - 350)}, est.`, '≈ 3 h 20 min, est.', expect.stringMatching(/^≈ .* to the last scheduled match, est\.$/), 'weeks'])
    expect(s.find((x) => x.suggested)!.id).toBe('gap-7')
    expect(s[1].until).toEqual({ kind: 'gap', match: 'Q7', minutes: 24 * 60 - 60 + 600 - 350 })
    expect(s[0].until).toEqual({ kind: 'next-match', match: 'Q6' })
  })
  it('without a schedule: the next match, before playoffs, the end of the event and the next event, with no estimates', () => {
    const s = suggestions(timeline(scene({ 5: [D] }), null, () => 'Q5'))
    expect(s.map((x) => x.id)).toEqual(['next', 'playoffs', 'end', 'event'])
    expect(s[0].estimate).toBe('no estimate')
    expect(s[0].until).toEqual({ kind: 'next-match' })
    expect(s.find((x) => x.suggested)!.id).toBe('next')
  })
})

describe('issues, priority and status', () => {
  it('one issue per key, from the matches and the pit runs; a pit run is a sighting, never a match', () => {
    const b = buildBoard(input(scene({ 3: [A], 4: [A] }, { pit: { 500: [A, B] } })))
    expect(b.issues.map((i) => i.key).sort()).toEqual([A, B].sort())
    expect(byKey(b, A).firedIn).toEqual([1, 2])
    expect(byKey(b, A).sightings.map((x) => x.kind)).toEqual(['match', 'match', 'pit'])
    expect(byKey(b, B).firedIn).toEqual([])
    expect(byKey(b, B).sightings.map((x) => [x.kind, x.label])).toEqual([['pit', 'Pit run']])
  })
  it('priority comes from severity (an error is red, a warning amber) until a board line sets it', () => {
    const s = scene({ 5: [D, C] })
    let b = buildBoard(input(s))
    expect([byKey(b, D).priority, byKey(b, C).priority]).toEqual(['red', 'amber'])
    b = buildBoard(input(s, [bl(D, 'priority', 'low', iso(1)), bl(C, 'priority', 'high', iso(1))]))
    expect([byKey(b, D).priority, byKey(b, C).priority, byKey(b, D).prioritySet]).toEqual(['low', 'red', true])
  })
  it('an E-stop defaults to amber whatever its severity, unless a board line sets the priority; its action is the no-blame question (owner ruling 2026-10-24)', () => {
    const E_STOP = 'comms/emergency-stop'
    const s = scene({ 5: [{ key: E_STOP, severity: 'error' }, D] })
    let b = buildBoard(input(s))
    expect([byKey(b, E_STOP).priority, byKey(b, D).priority]).toEqual(['amber', 'red'])
    expect(byKey(b, E_STOP).nextStep).toBe("Ask the drive team whether the E-stop was planned (no blame); if it wasn't, look for the fault just before it.")
    b = buildBoard(input(s, [bl(E_STOP, 'priority', 'high', iso(1))]))
    expect(byKey(b, E_STOP).priority).toBe('red')
    expect(b.strip.gate).toBe(2)
  })
  it('status is open by default, then the latest status line; the owner is a role', () => {
    const s = scene({ 5: [D] })
    const b = buildBoard(input(s, [bl(D, 'status', 'fixing', iso(1)), bl(D, 'owner', 'software', iso(2))]))
    expect(byKey(b, D)).toMatchObject({ status: 'fixing', owner: 'software' })
    expect(buildBoard(input(s)).issues[0]).toMatchObject({ status: 'open', owner: null })
  })
  it('issues on another robot start fresh: a board line is keyed by the robot of the latest log it fired in', () => {
    const s = scene({ 4: [D], 5: [D] }, { robots: { 5: 'Other robot @ main' } })
    const b = buildBoard(input(s, [bl(D, 'priority', 'low', iso(1))]))
    expect(byKey(b, D)).toMatchObject({ robot: 'Other robot @ main', priority: 'red' })
  })
  it('an issue marked not a real problem in every match it fired in is filed, not on the board', () => {
    const b = buildBoard(input(scene({ 4: [{ key: D, wrongMark: true }], 5: [{ key: D, wrongMark: true }] })))
    expect(b.issues).toEqual([])
  })
  it('names the mechanism from the profile, else the rule family', () => {
    expect(mechanismOf('mech/follower-mismatch', 'Flywheel left', profile)).toEqual({ name: 'Flywheel', byProfile: true })
    expect(mechanismOf('vision/stale', 'Front camera', profile)).toEqual({ name: 'Front camera', byProfile: true })
    expect(mechanismOf('can/device-dropout', 'Unknown thing', profile)).toEqual({ name: 'CAN', byProfile: false })
    expect(mechanismOf('power/brownout', null, undefined)).toEqual({ name: 'Power', byProfile: false })
    expect(mechanismOf('comms/loss', null, profile).name).toBe('Comms')
    expect(mechanismOf('loop/overrun', null, profile).name).toBe('Code')
    expect(mechanismOf('collision/tilt', null, profile).name).toBe('Other')
  })
})

describe('closed is derived, never stored', () => {
  const fired = scene({ 2: [A], 3: [A], 4: [], 5: [] })
  const check = bl(A, 'status', 'check', after(3), ref(3))
  it('after a check line, a later match of the same robot where the rule was checkable and the key did not fire closes it', () => {
    const b = buildBoard(input(fired, [check]))
    expect(byKey(b, A)).toMatchObject({ status: 'closed', closedAt: 'Q4', cameBack: false, open: false })
    expect(b.rows).toEqual([])
    expect(b.closed).toHaveLength(1)
  })
  it('the same with the existing fixed mark', () => {
    const mark: IssueEvent = { type: 'issue', key: A, status: 'fixed', note: 'test reason', when: after(3), ...ref(3) }
    expect(byKey(buildBoard(input(fired, [mark])), A).status).toBe('closed')
  })
  it('until that match is played it reads "Check next match"', () => {
    const soon = scene({ 2: [A], 3: [A] }, { upto: 3 })
    expect(byKey(buildBoard(input(soon, [bl(A, 'status', 'check', after(3), ref(3))])), A)).toMatchObject({ status: 'check', open: true })
  })
  it('a match where the rule could not be checked does not close it', () => {
    const s = scene({ 2: [A], 3: [A], 4: [], 5: [] }, { notChecked: { 4: [rule(A)] } })
    // The scene marks the rule quiet everywhere it is not fired; override Q4 to "not checked".
    s.matches[2].rules[rule(A)] = { status: 'not checked', findings: [], reason: 'test reason' }
    expect(byKey(buildBoard(input(s, [check])), A)).toMatchObject({ status: 'closed', closedAt: 'Q5' })
    s.matches[3].rules[rule(A)] = { status: 'not checked', findings: [], reason: 'test reason' }
    expect(byKey(buildBoard(input(s, [check])), A)).toMatchObject({ status: 'check', closedAt: null })
  })
  it('a clean match of another robot does not close it', () => {
    const s = scene({ 2: [A], 3: [A], 4: [], 5: [] }, { robots: { 4: 'Other robot @ main', 5: 'Other robot @ main' } })
    // The latest fire is on the first robot (Q3); the clean matches are on the other one.
    expect(byKey(buildBoard(input(s, [check])), A)).toMatchObject({ status: 'check', robot: ROBOT })
  })
  it('firing again after the fix is "came back after a fix" and reopens it, even after a clean match', () => {
    const s = scene({ 2: [A], 3: [A], 4: [], 5: [A] })
    expect(byKey(buildBoard(input(s, [check])), A)).toMatchObject({ status: 'open', cameBack: true, closedAt: null })
    const cleanThenFire = scene({ 2: [A], 3: [A], 4: [], 5: [A] })
    expect(byKey(buildBoard(input(cleanThenFire, [check])), A).cameBack).toBe(true)
  })
  it('a pit-run sighting after the fix reopens it, but a clean pit run never closes it', () => {
    const quietPit = scene({ 2: [A], 3: [A] }, { pit: { 100: [D] }, upto: 3 })
    expect(byKey(buildBoard(input(quietPit, [check])), A).status).toBe('check')
    const firePit = scene({ 2: [A], 3: [A], 4: [] }, { pit: { 90: [A] }, upto: 4 })
    expect(byKey(buildBoard(input(firePit, [check])), A)).toMatchObject({ cameBack: true, status: 'open' })
  })
  it('a student who sets the issue back to open or fixing after the fixed mark withdraws the fix', () => {
    const mark: IssueEvent = { type: 'issue', key: A, status: 'fixed', note: 'test reason', when: after(3), ...ref(3) }
    expect(byKey(buildBoard(input(fired, [mark, bl(A, 'status', 'fixing', after(3).replace(/:\d\d\./, ':59.'))])), A)).toMatchObject({ status: 'fixing' })
  })
})

describe('deferrals', () => {
  const s = scene({ 4: [D], 5: [D] })
  const defer = (until: BoardEvent['until'], wk = 'test workaround') => [bl(D, 'workaround', wk, iso(1)), bl(D, 'defer', until!.kind, iso(1), { until })]
  it('a live deferral gives the status, its point and its workaround; one due before the next match is in the "due" class', () => {
    const due = buildBoard(input(s, defer({ kind: 'next-match', match: 'Q6' })))
    expect(byKey(due, D)).toMatchObject({ status: 'deferred', cls: 'due' })
    expect(byKey(due, D).deferral).toMatchObject({ workaround: 'test workaround', expired: false, point: { pos: 5.5, until: 'Q6', redecide: 'at Q6' } })
    const later = buildBoard(input(s, defer({ kind: 'gap', match: 'Q7' })))
    expect(byKey(later, D)).toMatchObject({ status: 'deferred', cls: 'later' })
    expect(byKey(later, D).due.text).toBe('after Q7 (overnight)')
  })
  it('a deferral whose point is behind the next match has ended: the issue is open again, on its own priority', () => {
    const ended = buildBoard(input(s, defer({ kind: 'next-match', match: 'Q3' })))
    expect(byKey(ended, D)).toMatchObject({ status: 'open', cls: 'carried' })
    expect(byKey(ended, D).deferral?.expired).toBe(true)
  })
  it('clearing the deferral (an empty defer line) takes the issue back to open', () => {
    const b = buildBoard(input(s, [...defer({ kind: 'end-of-event' }), bl(D, 'defer', '', iso(3))]))
    expect(byKey(b, D).deferral).toBeNull()
  })
  it('the deferral lines a person writes: the workaround first, then the deferral, in one stamped run', () => {
    const lines = boardLines([], { device: 'dev-x', role: 'pit' }, new Date(iso(5)), { key: D, robot: ROBOT }, deferChanges('  hold the arm low  ', { kind: 'next-event' }), atLatest(s))
    expect(lines.map((l) => [l.op, l.value, l.seq])).toEqual([['workaround', 'hold the arm low', 1], ['defer', 'next-event', 2]])
    expect(lines[0]).toMatchObject({ match: 'TEST Qualification 5', event: 'TEST', by: { device: 'dev-x', role: 'pit' } })
    expect(JSON.stringify(lines)).not.toMatch(/name/i)
  })
})

describe('classes and order', () => {
  // Q2..Q5. Handoff read after Q3 (index 1). A fired only in Q2 (grey after Q5: 3 matches since), B in Q2,Q3,Q4 (carried), C first in Q4 (new),
  // D first in Q5 (new, red), E carried amber, F deferred to the next match (due), G deferred to the overnight gap (later).
  const spec = { 2: [A, B], 3: [B, E], 4: [B, C, E, F], 5: [D, E, F, G, C] }
  const read = note('handoff-read', '', 'Q3', after(3))
  const hist: HistoryEvent[] = [
    read,
    bl(F, 'workaround', 'test workaround', iso(1)), bl(F, 'defer', 'next-match', iso(1), { until: { kind: 'next-match', match: 'Q6' } }),
    bl(G, 'workaround', 'test workaround', iso(1)), bl(G, 'defer', 'gap', iso(1), { until: { kind: 'gap', match: 'Q7' } }),
  ]
  const b = buildBoard(input(scene(spec), hist))
  const cls = (k: string) => byKey(b, k).cls
  it('classes: due, new, carried, later, grey', () => {
    expect(cls(F)).toBe('due')
    expect([cls(C), cls(D)]).toEqual(['new', 'new'])
    expect([cls(B), cls(E)]).toEqual(['carried', 'carried'])
    expect(cls(G)).toBe('later')
    expect(cls(A)).toBe('grey')
  })
  it('order: due, new, carried, later, grey; inside a class reds first, then by due point', () => {
    expect(b.rows.map((i) => i.key)).toEqual([F, D, C, B, E, G, A])
    // new: D (red, before Q6) ahead of C (amber, after Q7); carried: B (red) ahead of E (amber).
  })
  it('"new" is first seen after the last handoff read; with no handoff read nothing is new', () => {
    expect(byKey(buildBoard(input(scene(spec))), D).isNew).toBe(false)
    expect(b.handoff).toMatchObject({ role: 'pit', match: 'Q3' })
  })
  it('grey: no sighting and no board change for 3 of the team\'s matches, and not deferred; a board change brings it back', () => {
    expect(byKey(b, A)).toMatchObject({ grey: true, unchanged: 3 })
    const touched = buildBoard(input(scene(spec), [...hist, bl(A, 'note', 'test reason', after(5), ref(5))]))
    expect(byKey(touched, A)).toMatchObject({ grey: false, cls: 'carried' })
    const sighted = buildBoard(input(scene({ ...spec, 5: [...spec[5], A] }), hist))
    expect(byKey(sighted, A).grey).toBe(false)
    const deferred = buildBoard(input(scene(spec), [...hist, bl(A, 'workaround', 'test workaround', iso(1)), bl(A, 'defer', 'end-of-event', iso(1), { until: { kind: 'end-of-event' } })]))
    expect(byKey(deferred, A)).toMatchObject({ grey: false, cls: 'later' })
  })
  it('a grey issue asks "close it, or give it an owner?" in place of a due point; Close files check and closes after the next clean match; Give it an owner files open and a note and leaves grey', () => {
    const grey = byKey(b, A)
    expect(grey.greyAsk).toBe('Not seen for 3 matches: close it, or give it an owner?')
    expect(byKey(b, D).greyAsk).toBeNull()
    const base = scene(spec)
    const who = { device: 'dev-x', role: 'software' as const }
    const closeLines = boardLines(hist, who, new Date(iso(300)), { key: A, robot: ROBOT }, greyClose(), atLatest(base))
    expect(closeLines.map((l) => [l.op, l.value])).toEqual([['status', 'check']])
    const closing = buildBoard(input(base, [...hist, ...closeLines]))
    expect(byKey(closing, A)).toMatchObject({ grey: false, status: 'check', greyAsk: null })
    const q6 = session([...base.matches, match(6, { quiet: [rule(A)] })])
    expect(byKey(buildBoard(input(q6, [...hist, ...closeLines])), A)).toMatchObject({ status: 'closed', closedAt: 'Q6' })
    const takeLines = boardLines(hist, who, new Date(iso(300)), { key: A, robot: ROBOT }, greyTake('software'), atLatest(base))
    expect(takeLines.map((l) => [l.op, l.value])).toEqual([['status', 'open'], ['note', 'Taken by software']])
    const taken = byKey(buildBoard(input(base, [...hist, ...takeLines])), A)
    expect(taken).toMatchObject({ grey: false, status: 'open', greyAsk: null })
    expect(taken.notes.map((n) => [n.role, n.text])).toEqual([['software', 'Taken by software']])
  })
  it('a grey red leaves the red count', () => {
    expect(byKey(b, A)).toMatchObject({ priority: 'red', grey: true })
    // D and B are red; A is red too but grey, and does not count.
    expect(b.strip.reds).toBe(2)
  })
  it('the strip leads with the gate: reds due before the next match, then the minutes, deferrals due, and no owner', () => {
    expect(b.strip).toMatchObject({ gate: 2, nextLabel: 'Q6', minutes: 55, deferralsDue: 1 })
    expect(b.strip.nextGap).toBe(`after Q7 (overnight) (≈ ${durText(24 * 60 - 60 + 600 - 350)}, est.)`)
    expect(b.strip.noOwner).toBe(b.rows.filter((i) => !i.grey).length)
    const owned = buildBoard(input(scene(spec), [...hist, bl(D, 'owner', 'software', iso(2))]))
    expect(owned.strip.noOwner).toBe(b.strip.noOwner - 1)
  })
})

describe('the red cap', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `power/brownout · ${x}`)
  const board = (extra: HistoryEvent[] = []) => buildBoard(input(scene({ 5: [...keys.map((key): Fire => ({ key, severity: 'error' })), { key: C, severity: 'warning' } as Fire] }), extra))
  it(`rows after the ${RED_CAP}th red go below the line, in order, and none is dropped`, () => {
    const b = board()
    expect(b.visible).toHaveLength(RED_CAP)
    expect(b.below.map((i) => i.key)).toEqual([...keys.slice(RED_CAP), C])
    expect(b.visible.length + b.below.length).toBe(b.rows.length)
    expect(b.strip.reds).toBe(7)
  })
  it('lowering a red to amber lets the next red up above the line', () => {
    const b = board([bl(keys[0], 'priority', 'medium', iso(1))])
    expect(b.visible.filter((i) => i.priority === 'red')).toHaveLength(RED_CAP)
    expect(b.below.filter((i) => i.priority === 'red')).toHaveLength(1)
    expect(b.strip.reds).toBe(6)
  })
})

describe('the queue sheet', () => {
  const s = scene({ 4: [A, D, C], 5: [A, D, C] })
  const defer = (k: string, wk = 'test workaround') => [bl(k, 'workaround', wk, iso(1)), bl(k, 'defer', 'end-of-event', iso(1), { until: { kind: 'end-of-event' } })]
  const tick = (k: string, when = iso(2)) => bl(k, 'checked', 'Q6', when, { match: 'TEST Qualification 5' })
  it('the gate is the reds due before the next match; nothing checked is NOT CLEARED, and a count of them', () => {
    const b = buildBoard(input(s))
    const q = queueSheet(b)
    expect(q.gate).toBe(2)
    expect(q.forMatch).toBe('Q6')
    expect(q.verdict).toEqual({ cleared: false, text: 'NOT CLEARED: 2 REDS TO CONFIRM' })
    expect(q.lines.map((l) => [l.kind, l.issue.key]).sort()).toEqual([['gate', A], ['gate', D]].sort())
  })
  it('some checked: still NOT CLEARED, with the rest counted; the tick records its role and time', () => {
    const q = queueSheet(buildBoard(input(s, [tick(A)])))
    expect(q.verdict.text).toBe('NOT CLEARED: 1 RED TO CONFIRM')
    expect(q.lines.find((l) => l.issue.key === A)!.checked).toEqual({ role: 'pit', when: iso(2) })
    expect(q.lines.find((l) => l.issue.key === D)!.checked).toBeNull()
  })
  it('a tick for another match does not count', () => {
    const q = queueSheet(buildBoard(input(s, [bl(A, 'checked', 'Q2', iso(2)), bl(D, 'checked', 'Q2', iso(2))])))
    expect(q.toConfirm).toBe(2)
  })
  it('all checked or deferred: GO WITH the deferrals and the reds still open; never plain GO', () => {
    const q = queueSheet(buildBoard(input(s, [tick(A), ...defer(D)])))
    expect(q.verdict).toEqual({ cleared: true, text: 'GO WITH 1 DEFERRAL · 1 RED OPEN' })
    expect(q.lines.map((l) => [l.kind, l.issue.key])).toEqual([['gate', A], ['deferral', D]])
    expect(q.lines[1].issue.deferral?.workaround).toBe('test workaround')
    const none = queueSheet(buildBoard(input(s, [tick(A), tick(D), ...defer(C)])))
    expect(none.verdict.text).toBe('GO WITH 1 DEFERRAL · 2 REDS OPEN')
    expect(none.verdict.text).not.toMatch(/^GO\b(?! WITH)/)
    const zero = queueSheet(buildBoard(input(scene({ 5: [C] }))))
    expect(zero.verdict.text).toBe('GO WITH 0 DEFERRALS · 0 REDS OPEN')
  })
  it('holds at most 7 lines: the gate reds, then the deferrals; the rest are counted', () => {
    const many = Array.from({ length: 9 }, (_, i) => `power/brownout · r${i}`)
    const big = scene({ 5: many.map((key) => ({ key, severity: 'error' as const })) })
    const defers = many.slice(4).flatMap((k) => defer(k))
    const q = queueSheet(buildBoard(input(big, defers)))
    expect(q.gate).toBe(4)
    expect(q.lines).toHaveLength(SHEET_LINES)
    expect(q.lines.map((l) => l.kind)).toEqual(['gate', 'gate', 'gate', 'gate', 'deferral', 'deferral', 'deferral'])
    expect(q.more).toBe(2)
  })
  it('a deferred red is not in the gate', () => {
    const b = buildBoard(input(s, defer(D)))
    expect(isGate(byKey(b, D), b.tl)).toBe(false)
    expect(isGate(byKey(b, A), b.tl)).toBe(true)
  })
})

describe('the handoff', () => {
  const s = scene({ 3: [B], 4: [B, D, C], 5: [B, D, C] })
  it('lists the reds due before the next match, the deferrals due, what was tried and what is new since the last read', () => {
    const hist: HistoryEvent[] = [
      note('handoff-read', '', 'Q3', after(3)),
      bl(D, 'note', 'swapped the battery, no change', after(4), ref(4)),
      bl(C, 'workaround', 'test workaround', iso(1)), bl(C, 'defer', 'next-match', iso(1), { until: { kind: 'next-match', match: 'Q6' } }),
      note('pit-change', 'test pit line', 'Q5', after(5)),
    ]
    const h = handoff(buildBoard(input(s, hist)))
    expect(h.firstRead).toBe(false)
    expect(h.redsDue.map((i) => i.key)).toEqual([D, B])
    expect(h.deferralsDue.map((i) => i.key)).toEqual([C])
    expect(h.tried.map((t) => [t.issue.key, t.text, t.role, t.match])).toEqual([[D, 'swapped the battery, no change', 'pit', 'Q4']])
    expect(h.newSince.map((i) => i.key).sort()).toEqual([C, D].sort())
    expect(h.pitLines).toEqual([{ match: 'Q5', text: 'test pit line', role: 'pit' }])
  })
  it('with no handoff read yet, everything is new to the reader, and the board marks nothing new', () => {
    const b = buildBoard(input(s))
    const h = handoff(b)
    expect(h.firstRead).toBe(true)
    expect(h.newSince).toHaveLength(b.rows.length)
    expect(b.rows.some((i) => i.isNew)).toBe(false)
  })
  it('what the logs ruled out is listed with the cause in words', () => {
    const withRuledOut = scene({ 4: [D], 5: [D] })
    const f = withRuledOut.matches[3].rules['power/brownout'].findings[0]
    f.ruledOut = { 'battery-weak': 'test reason' }
    const h = handoff(buildBoard(input(withRuledOut)))
    expect(h.ruledOut).toHaveLength(1)
    expect(h.ruledOut[0]).toMatchObject({ why: 'test reason' })
  })
})

describe('event notes on the board', () => {
  it('what we changed in the pit: the latest line per match wins, an empty line clears it; missed lines are listed; other events are ignored', () => {
    const hist: HistoryEvent[] = [
      note('pit-change', 'first', 'Q5', iso(1)), note('pit-change', 'second', 'Q5', iso(2)), note('pit-change', 'other match', 'Q4', iso(3)),
      note('pit-change', 'elsewhere', 'Q5', iso(4), { event: 'ELSEWHERE' }), note('pit-change', '', 'Q4', iso(5)),
      note('missed', 'test reason', 'Q5', iso(6)),
    ]
    const b = buildBoard(input(scene({ 5: [D] }), hist))
    expect(b.pitLines).toEqual([{ match: 'Q5', text: 'second', role: 'pit' }])
    expect(b.missed).toMatchObject([{ text: 'test reason', role: 'pit', match: 'Q5' }])
  })
  it('a note written under the event name still counts once the Blue Alliance key is found', () => {
    const s = { ...scene({ 5: [D] }), event: { key: '2099test', name: 'Test Regional' } } as never
    const b = buildBoard(input(s, [note('pit-change', 'before the key', 'Q5', iso(1)), note('pit-change', 'after the key', 'Q5', iso(2), { event: '2099test' }), note('handoff-read', '', 'Q3', iso(3))]))
    expect(b.pitLines).toEqual([{ match: 'Q5', text: 'after the key', role: 'pit' }])
    expect(b.handoff).toMatchObject({ match: 'Q3' })
  })
  it('a note line is stamped with the next seq for its device, counted with the device\'s board lines', () => {
    const l = noteLine([bl(D, 'note', 'x', iso(1), { seq: 7, by: { device: 'dev-z', role: 'pit' } })], { device: 'dev-z', role: 'drive' }, new Date(iso(0)), 'missed', 'TEST', 'Q5', 'test reason')
    expect(l).toMatchObject({ type: 'event-note', v: 1, kind: 'missed', seq: 8, by: { device: 'dev-z', role: 'drive' } })
    expect(l.when >= iso(1)).toBe(true)
  })
})

describe('the rule track record table', () => {
  it('one row per rule that fired at the event, with the counts beside the rate', () => {
    const s = scene({ 3: [D], 4: [D, C], 5: [D] })
    const hist: HistoryEvent[] = [{ type: 'issue', key: D, status: 'wrong', note: 'test reason', when: iso(100), ...ref(3) }]
    const rows = ruleRates(s, input(s, hist).marks, hist)
    const power = rows.find((r) => r.rule === 'power/brownout')!
    expect(power).toMatchObject({ fired: 3, wrong: 1 })
    expect(power.text).toBe('1 of 3 marked not a real problem')
    expect(rows.find((r) => r.rule === 'comms/loss')!.text).toBe('no marks yet (fired 1 time)')
    expect(rows.map((r) => r.rule)).toEqual(['power/brownout', 'comms/loss'])
  })
})
