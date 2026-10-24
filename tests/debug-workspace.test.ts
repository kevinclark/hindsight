// The debug workspace and the Claude export with notes (slice 14). Everything here is invented (event TEST, robot "Test robot", reason "test reason").
import { describe, expect, it } from 'vitest'
import { analyzeFixture } from './helpers/load.ts'
import { debugCauses, markText, rankNote, readReverse, REVERSE_KEY, ruledOutText, writeReverse } from '../src/board/debug.ts'
import { buildBoard } from '../src/board/model.ts'
import { handoff, queueSheet } from '../src/board/sheets.ts'
import { atLatest, boardLines, causeChange, type Who } from '../src/board/writes.ts'
import { dueLine } from '../src/board/words.ts'
import { boardKey, boardState, mergeHistory, parseHistory, serializeHistory, triage, type BoardEvent, type HistoryEvent, type OpaqueEvent } from '../src/triage/history.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import { contentsLines, exportContents } from '../src/report/board-export.ts'
import { buildSessionJson } from '../src/session/export.ts'
import { robotIdOf, matchRobot } from '../src/session/summary.ts'
import { makerOf } from '../src/rules/index.ts'
import { BASE, RAW, ROBOT, input, match, session } from './helpers/board-scene.ts'
import { parseSchedule } from '../src/tba/schedule.ts'

const RULE = 'power/brownout'
const KEY = RULE
const causes = makerOf(RULE)!.causes
const who: Who = { device: 'dev-a', role: 'pit' }
const t = (min: number) => new Date(BASE + min * 60e3)
const mark = (cause: string, state: 'possible' | 'ruled-out' | 'confirmed', text: string, min: number, w: Who = who, history: HistoryEvent[] = []) =>
  boardLines(history, w, t(min), { key: KEY, robot: ROBOT }, causeChange(cause, state, text), {})

describe('the cause op', () => {
  const [a, b] = causes
  it('folds the latest state per cause, beside the board state', () => {
    const h1 = mark(a.id, 'ruled-out', 'swapped the battery: the dip stayed', 1)
    const h2 = mark(a.id, 'confirmed', 'a loose lug', 5, who, h1)
    const h3 = mark(b.id, 'possible', 'watch the pit run', 6, { device: 'dev-b', role: 'software' }, [...h1, ...h2])
    const s = boardState([...h1, ...h2, ...h3]).get(boardKey(KEY, ROBOT))!
    expect(Object.keys(s.causes!)).toEqual([a.id, b.id])
    expect(s.causes![a.id]).toMatchObject({ state: 'confirmed', text: 'a loose lug', by: { role: 'pit' } })
    expect(s.causes![b.id]).toMatchObject({ state: 'possible', text: 'watch the pit run', by: { role: 'software' } })
    expect(s.changed).toBe(true)
  })
  it('back to possible with no text clears it; a possible with a note is kept', () => {
    const h1 = mark(a.id, 'ruled-out', 'test reason: it showed', 1)
    const h2 = mark(a.id, 'possible', '', 2, who, h1)
    expect(boardState([...h1, ...h2]).get(boardKey(KEY, ROBOT))!.causes).toBeUndefined()
  })
  it('does not disturb priority, status, notes or ticks', () => {
    const base = boardLines([], who, t(0), { key: KEY, robot: ROBOT }, [{ op: 'priority', value: 'low' }, { op: 'note', value: 'test reason' }], {})
    const withCause = [...base, ...mark(a.id, 'confirmed', '', 3, who, base)]
    const s = boardState(withCause).get(boardKey(KEY, ROBOT))!
    expect(s).toMatchObject({ priority: 'low' })
    expect(s.notes.map((n) => n.text)).toEqual(['test reason'])
  })
  it('validates: an unknown state, or no cause id, is kept unread', () => {
    const line = mark(a.id, 'confirmed', 'x', 1)[0]
    expect(parseHistory(JSON.stringify(line)).events[0]).toMatchObject({ type: 'board', op: 'cause', cause: a.id })
    expect(parseHistory(JSON.stringify({ ...line, value: 'likely' })).events[0].type).toBe('opaque')
    expect(parseHistory(JSON.stringify({ ...line, cause: '' })).events[0].type).toBe('opaque')
    expect(parseHistory(JSON.stringify({ ...line, text: 5 })).events[0].type).toBe('opaque')
  })
  it('stamps like the other board lines: a rising seq per device', () => {
    const h1 = mark(a.id, 'confirmed', '', 1)
    const h2 = mark(b.id, 'confirmed', '', 1, who, h1)
    expect([h1[0].seq, h2[0].seq]).toEqual([1, 2])
  })
  describe('an old build', () => {
    // An old build types only the board ops it knows; a `cause` line is a well-formed JSON object it keeps as an OpaqueEvent.
    const line = JSON.stringify(mark(a.id, 'ruled-out', 'test reason: it showed', 3)[0])
    const heldByOld: OpaqueEvent = { type: 'opaque', raw: line, when: JSON.parse(line).when }
    const old: HistoryEvent[] = [{ type: 'issue', key: KEY, status: 'known', note: 'test reason', when: t(1).toISOString() }]
    it('writes the line back byte for byte', () => {
      expect(serializeHistory([...old, heldByOld])).toBe(`${serializeHistory(old)}${line}\n`)
      const typed = parseHistory(`${serializeHistory(old)}${line}\n`)
      expect(typed.skipped).toBe(0)
      // This build types the line and writes it back the same (a typed issue line may reorder its keys; the cause line may not).
      expect(typed.events.at(-1)).toMatchObject({ type: 'board', op: 'cause' })
      expect(serializeHistory([typed.events.at(-1)!])).toBe(`${line}\n`)
    })
    it('folds nothing for the issue, and merging keeps it once', () => {
      expect(boardState([heldByOld]).size).toBe(0)
      expect(JSON.stringify([...triage([...old, heldByOld]).issues])).toBe(JSON.stringify([...triage(old).issues]))
      const merged = mergeHistory(old, [heldByOld])
      expect(mergeHistory(merged, [heldByOld])).toEqual(merged)
    })
  })
})

describe('the causes in order', () => {
  it('lists this log\'s pointed-at causes first, then the rule\'s order; "possible" by default', () => {
    const last = causes.at(-1)!
    const list = debugCauses(causes, { likely: [last.id] }, undefined)
    expect(list[0]).toMatchObject({ id: last.id, points: true, state: 'possible' })
    expect(list.slice(1).map((c) => c.id)).toEqual(causes.filter((c) => c.id !== last.id).map((c) => c.id))
    expect(list.every((c) => c.state === 'possible' && c.role === null)).toBe(true)
  })
  it('the reverse switch flips the whole list, and nothing else', () => {
    const fwd = debugCauses(causes, { likely: [causes[1].id] }, undefined)
    const rev = debugCauses(causes, { likely: [causes[1].id] }, undefined, true)
    expect(rev.map((c) => c.id)).toEqual(fwd.map((c) => c.id).reverse())
    expect(rev.find((c) => c.id === causes[1].id)).toEqual(fwd.find((c) => c.id === causes[1].id))
  })
  it('the switch is a local setting: off unless set, and survives a blocked store', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    expect(readReverse(store)).toBe(false)
    writeReverse(store, true)
    expect(mem.get(REVERSE_KEY)).toBe('on')
    expect(readReverse(store)).toBe(true)
    writeReverse(store, false)
    expect(readReverse(store)).toBe(false)
    expect(readReverse({ getItem: () => { throw new Error('blocked') }, setItem: () => {} })).toBe(false)
  })
  it('keeps a rule\'s own ruled-out as Hindsight\'s, apart from the team\'s state', () => {
    const [a] = causes
    const list = debugCauses(causes, { ruledOut: { [a.id]: 'the radio stayed linked' } }, { [a.id]: { state: 'confirmed', text: '', by: { role: 'pit' }, when: 'x' } })
    expect(list.find((c) => c.id === a.id)).toMatchObject({ hindsightRuledOut: 'the radio stayed linked', state: 'confirmed', role: 'pit' })
  })
  it('says what the ranking rests on, with "possible", never "likely"', () => {
    expect(rankNote(4, 1)).toMatch(/from 4 measured numbers/)
    expect(rankNote(1, 2)).toMatch(/from 1 measured number in/)
    expect(rankNote(0, 0)).toMatch(/no measured number/)
    for (const n of [rankNote(4, 1), rankNote(0, 0)]) { expect(n).toMatch(/possible causes, not likely ones/); expect(n.replace('not likely ones', '')).not.toMatch(/likely/) }
  })
  it('words the states', () => {
    expect(ruledOutText(' swapped the cable ', ' the drops went on ')).toBe('swapped the cable: the drops went on')
    expect(markText({ state: 'ruled-out', text: 'a: b' })).toBe('ruled out by a: b')
    expect(markText({ state: 'confirmed', text: '' })).toBe('confirmed')
  })
})

describe('the board and the handoff show the causes ruled out', () => {
  const s = session([match(2, { fires: [{ key: KEY }] }), match(3, { fires: [{ key: KEY }] })])
  const [a, b, c] = causes
  const lines = [
    ...mark(a.id, 'ruled-out', 'unplugged the radio: the drops went on', 55),
    ...mark(b.id, 'confirmed', 'a loose lug', 56, { device: 'dev-b', role: 'software' }, mark(a.id, 'ruled-out', 'x', 55)),
  ]
  const board = buildBoard({ ...input(s, lines), now: t(70) })
  const issue = board.issues[0]
  it('puts the states on the issue, by role', () => {
    expect(issue.causeMarks[a.id]).toMatchObject({ state: 'ruled-out', role: 'pit' })
    expect(issue.causeMarks[b.id]).toMatchObject({ state: 'confirmed', role: 'software' })
    expect(issue.causeMarks[c.id]).toBeUndefined()
  })
  it('the handoff lists the team\'s ruled-out and confirmed causes, apart from Hindsight\'s', () => {
    const h = handoff(board)
    expect(h.ruledOut.filter((r) => r.by === 'team')).toEqual([expect.objectContaining({ cause: a.cause, why: expect.stringContaining('unplugged the radio'), role: 'pit' })])
    expect(h.confirmed).toEqual([expect.objectContaining({ cause: b.cause, text: 'a loose lug', role: 'software' })])
  })
})

describe('the queue sheet once the event is over, and a tick that goes old', () => {
  // Every match on the schedule played, a playoff match among them: the team is done (as tests/board-followups.test.ts).
  const done = parseSchedule(RAW.map((m) => ({ ...m, actual_time: m.time ?? BASE / 1000 })) as never)
  const s = session([match(2, { fires: [{ key: KEY }] }), match(3, { fires: [{ key: KEY }] })])
  it('says so instead of "before the next match", on the sheet, in each row\'s due line and in the print words', () => {
    const b = buildBoard({ ...input(s, [], done), now: t(2000) })
    expect(b.strip.over).toBe(true)
    expect(queueSheet(b)).toMatchObject({ over: true, when: 'open · the event is over', gate: 1 })
    expect(dueLine(b.issues[0])).toBe('Open · the event is over')
    expect(queueSheet(b).when).not.toMatch(/before the next match/)
  })
  it('with matches left it reads as before', () => {
    const b = buildBoard({ ...input(session([match(2, { fires: [{ key: KEY }] })]), []), now: t(60) })
    expect(queueSheet(b)).toMatchObject({ over: false, when: 'before Q3' })
    expect(dueLine(b.issues[0])).toBe('Due before Q3')
  })
  it('a tick is fresh for 90 minutes, then old and the red needs a new tick', () => {
    const sess = session([match(2, { fires: [{ key: KEY }] })])
    const tick = boardLines([], who, t(41), { key: KEY, robot: ROBOT }, [{ op: 'checked', value: 'Q3' }], { match: 'TEST Qualification 2', event: 'TEST', played: t(40).toISOString() })
    const at = (min: number) => queueSheet(buildBoard({ ...input(sess, tick), now: t(min) }))
    expect(at(41 + 89).toConfirm).toBe(0)
    expect(at(41 + 89).lines[0]).toMatchObject({ checked: { role: 'pit' }, old: null })
    expect(at(41 + 91).toConfirm).toBe(1)
    expect(at(41 + 91).lines[0]).toMatchObject({ checked: null, old: { role: 'pit', ahead: false } })
    expect(at(41 + 91).verdict.text).toMatch(/^NOT CLEARED: 1 RED TO CONFIRM/)
  })
})

describe('the Claude export', () => {
  const { analyses } = analyzeFixture('brownout')
  const a = analyses[0]
  const robot = robotIdOf(matchRobot(a.match))
  const rule = a.report.findings.find((f) => makerOf(f.rule) && 'sources' in makerOf(f.rule)!)!
  const lines = (n: number): BoardEvent[] => {
    const l1 = boardLines([], who, t(1), { key: rule.key, robot }, [{ op: 'priority', value: 'high' }, { op: 'note', value: 'test reason' }, { op: 'owner', value: 'pit' }, { op: 'defer', value: 'next-match', until: { kind: 'next-match', match: 'Q9' } }, { op: 'workaround', value: 'Avoid the long shot.' }], {})
    const l2 = boardLines(l1, { device: 'dev-b', role: 'software' }, t(2), { key: rule.key, robot }, causeChange(rule.causes[0].id, 'ruled-out', 'swapped the battery: the dip stayed'), {})
    return [...l1, ...l2].slice(0, n)
  }
  const plain = () => JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report)))
  it('with no history, differs from the old file only by the per-rule sources block', () => {
    const withEmpty = JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states: boardState([]), robot })))
    const { generatedAt: g1, ...x } = plain()
    const { generatedAt: g2, ...y } = withEmpty
    expect(y).toEqual(x)
    const { rules, ...rest } = x
    expect(Object.keys(rules).length).toBeGreaterThan(0)
    expect(rules[rule.rule].sources.length).toBeGreaterThan(0)
    expect(rest.findings.every((f: any) => !('board' in f))).toBe(true)
    // Nothing but `rules` was added: every other top-level key is one the file already had.
    expect(Object.keys(rest)).toEqual(['schema', 'tool', 'excluded', 'match', 'findings', ...(rest.parents ? ['parents'] : []), 'notChecked', 'crashedRules', 'summary', 'power'])
  })
  it('carries the board state per issue, notes, cause states and roles only, when present', () => {
    const states = boardState(lines(99))
    const json = JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states, robot })))
    const f = json.findings.find((x: any) => x.key === rule.key)
    expect(f.board).toMatchObject({ priority: 'high', owner: 'pit', notes: [{ text: 'test reason', role: 'pit' }], deferred: { workaround: 'Avoid the long shot.', role: 'pit' } })
    expect(f.board.causes).toEqual([expect.objectContaining({ id: rule.causes[0].id, cause: rule.causes[0].cause, state: 'ruled-out', text: 'swapped the battery: the dip stayed', role: 'software' })])
    // Roles only: no device id anywhere in the file.
    expect(JSON.stringify(json)).not.toContain('dev-a')
    expect(JSON.stringify(json)).not.toContain('dev-b')
    // Findings the team recorded nothing on carry no `board`.
    expect(json.findings.filter((x: any) => x.key !== rule.key).every((x: any) => !('board' in x))).toBe(true)
  })
  it('carries cause states without notes, and notes without cause states', () => {
    const onlyCause = boardState(boardLines([], who, t(1), { key: rule.key, robot }, causeChange(rule.causes[0].id, 'confirmed', ''), {}))
    const j1 = JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states: onlyCause, robot })))
    expect(j1.findings.find((x: any) => x.key === rule.key).board).toEqual({ causes: [expect.objectContaining({ state: 'confirmed' })] })
    const onlyNote = boardState(boardLines([], who, t(1), { key: rule.key, robot }, [{ op: 'note', value: 'test reason' }], {}))
    const j2 = JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states: onlyNote, robot })))
    expect(j2.findings.find((x: any) => x.key === rule.key).board).toEqual({ notes: [expect.objectContaining({ text: 'test reason' })] })
  })
  it('files the issue under the robot, so another robot\'s notes are not carried', () => {
    const states = boardState(boardLines([], who, t(1), { key: rule.key, robot: 'Another robot' }, [{ op: 'note', value: 'test reason' }], {}))
    const json = JSON.parse(JSON.stringify(buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states, robot })))
    expect(json.findings.every((x: any) => !('board' in x))).toBe(true)
  })
  it('lists what is inside by counting the file itself, and says no names and no key hash', () => {
    const json = buildFindingsJson(a.match, a.report, new Map(), new Map(), new Map(), { states: boardState(lines(99)), robot })
    const c = exportContents(JSON.parse(JSON.stringify(json)))
    expect(c).toMatchObject({ findings: a.report.findings.length, boardIssues: 1, notes: 1, causeStates: 1 })
    expect(c.windows).toBe(a.report.findings.filter((f) => f.plot).length)
    const text = contentsLines(c, 123456).join('\n')
    expect(text).toContain(`${c.findings} finding`)
    expect(text).toContain('1 note, 1 cause state')
    expect(text).toMatch(/No names/)
    expect(text).toMatch(/Wi-Fi key hash/)
    expect(text).toMatch(/121 KB/)
  })
  it('the session file carries the board state and the rule sources too, and no device ids', () => {
    const s = session([match(2, { fires: [{ key: KEY }] }), match(3, { fires: [{ key: KEY }] })])
    const states = boardState(mark(causes[0].id, 'ruled-out', 'test reason: it showed', 5))
    const plainJson = JSON.parse(JSON.stringify(buildSessionJson(s)))
    const withBoard = JSON.parse(JSON.stringify(buildSessionJson(s, new Map(), {}, undefined, { states })))
    expect(plainJson.findings.every((f: any) => !('board' in f))).toBe(true)
    expect(withBoard.findings[0].board.causes[0]).toMatchObject({ state: 'ruled-out', role: 'pit' })
    expect(Object.keys(withBoard.rules)).toEqual([RULE])
    expect(JSON.stringify(withBoard)).not.toContain('dev-a')
    const { generatedAt: _g, ...x } = withBoard
    const { generatedAt: _h, ...y } = plainJson
    expect(Object.keys(x)).toEqual(Object.keys(y))
    expect(contentsLines(exportContents(withBoard), 10).join('\n')).toContain('2 matches')
  })
})

describe('where a change is written', () => {
  it('atLatest still names the latest on-field match for a cause line', () => {
    const s = session([match(2), match(3)])
    expect(atLatest(s)).toMatchObject({ match: expect.stringContaining('3') })
  })
})
