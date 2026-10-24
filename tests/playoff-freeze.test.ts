// Slice 16 (ADR 7): the playoff cut-off, the code change flag, fixes for reds only after it, and "still holds?" on each open deferral.
// Everything here is invented (event TEST, robot "Test robot", made-up commits); no real match, team or verdict.
import { describe, expect, it } from 'vitest'
import { buildBoard, deferralOptions, HOLDS, type BoardIssue } from '../src/board/model.ts'
import { codeChangeFlag, cutOffState, cutOffText, fixFolded, FREEZE_BANNER, isPlayoffLog, readCutOff } from '../src/board/freeze.ts'
import { suggestions, timeline } from '../src/board/points.ts'
import { noteLine } from '../src/board/writes.ts'
import { queueChecklist } from '../src/foresight/checklists.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import { sessionSchedule } from '../src/tba/session-schedule.ts'
import { createTba, memoryStore } from '../src/tba/source.ts'
import { changedFiles } from '../src/code/git.ts'
import type { CodeSource } from '../src/code/source.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { eventNotes, parseHistory, serializeHistory, type BoardEvent, type EventNote, type HistoryEvent } from '../src/triage/history.ts'
import { shortMatchLabel } from '../src/ui/match-label.ts'
import { BASE, ROBOT, SCHEDULE, input, match, profile, session } from './helpers/board-scene.ts'
import type { Report } from '../src/rules/index.ts'

const KEY = 'power/brownout · test'
const RULE = 'power/brownout'
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
let seq = 0
const cut = (text: string, when: string, o: Partial<EventNote> = {}): EventNote => ({
  type: 'event-note', v: 1, kind: 'cut-off', event: 'TEST', match: 'Q5', text, by: { device: 'dev-a', role: 'software' }, seq: ++seq, when, ...o,
})
const bl = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: KEY, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const fired = (n: number) => match(n, { fires: [{ key: KEY, severity: 'error' }] })
const withBuild = (m: MatchSummary, sha: string, uncommitted = false): MatchSummary => ({ ...m, build: { sha, branch: 'main', uncommitted } })
const playoff = (n: number): MatchSummary => ({ ...match(n), matchLabel: `Elimination ${n}`, matchType: 3 })
const label = (m: MatchSummary) => shortMatchLabel(m.matchLabel, 0)
const tlOf = (matches: MatchSummary[], schedule: typeof SCHEDULE | null = SCHEDULE) => timeline(session(matches), schedule, label)

describe('the cut-off line', () => {
  it('round-trips through the history file, and the latest line for the event wins', () => {
    const lines: HistoryEvent[] = [cut('alliance-selection', iso(1)), cut('Q4', iso(2)), cut('off', iso(3))]
    const r = parseHistory(serializeHistory(lines))
    expect(r.skipped).toBe(0)
    expect(r.events).toEqual(lines)
    expect(eventNotes(r.events).cutOff?.text).toBe('off')
    expect(eventNotes([]).cutOff).toBeNull()
  })
  it('an unknown kind (what an older build sees) is kept unread, and written back as it came', () => {
    const raw = JSON.stringify(cut('Q4', iso(1)))
    const older = JSON.stringify({ ...JSON.parse(raw), kind: 'a-kind-from-a-newer-build' })
    const r = parseHistory(older)
    expect(r.events.map((e) => e.type)).toEqual(['opaque'])
    expect(serializeHistory(r.events).trim()).toBe(older)
  })
  it('reads alliance-selection, a match label and off; anything else is the default, never off', () => {
    expect(readCutOff('alliance-selection')).toEqual({ kind: 'alliance-selection' })
    expect(readCutOff('Q40')).toEqual({ kind: 'after', match: 'Q40', qual: 40 })
    expect(readCutOff('off')).toEqual({ kind: 'off' })
    for (const odd of ['', undefined, 'lunch', 'SF1M1', 'Q', 'q40', 'Qualification 40']) expect(readCutOff(odd)).toEqual({ kind: 'alliance-selection' })
    for (const t of ['alliance-selection', 'Q40', 'off']) expect(cutOffText(readCutOff(t))).toBe(t)
  })
})

describe('when the cut-off has passed', () => {
  const state = (text: string | undefined, matches: MatchSummary[], schedule: typeof SCHEDULE | null = SCHEDULE) => cutOffState(readCutOff(text), tlOf(matches, schedule), matches)
  it('default: not before the team\'s last qualification (Q41), passed once it has been played', () => {
    expect(state(undefined, [match(40)]).passed).toBe(false)
    expect(state(undefined, [match(40)]).banner).toBeNull()
    const s = state(undefined, [match(40), match(41)])
    expect(s).toMatchObject({ passed: true, banner: FREEZE_BANNER, words: 'alliance selection (the default)' })
    expect(s.why).toContain('Q41')
  })
  it('the banner reads as the brief words it', () => expect(FREEZE_BANNER).toBe('Playoffs: analysis first. Code changed since the last match is flagged.'))
  it('set to after Q4: passed from Q4, not before', () => {
    expect(state('Q4', [match(3)]).passed).toBe(false)
    expect(state('Q4', [match(3), match(4)]).passed).toBe(true)
    expect(state('Q4', [match(3), match(5)]).passed).toBe(true)
  })
  it('off: never passes, not even in the playoffs', () => {
    expect(state('off', [match(40), match(41)]).passed).toBe(false)
    expect(state('off', [match(41), playoff(1)]).passed).toBe(false)
    expect(state('off', [match(41)]).banner).toBeNull()
  })
  it('an on-field playoff log passes the default and an unmet "after" alike', () => {
    expect(state(undefined, [match(5), playoff(1)]).passed).toBe(true)
    expect(state('Q40', [match(5), playoff(1)]).passed).toBe(true)
  })
  it('with no schedule only a playoff log passes the default; "after Qn" still counts the qualifications played', () => {
    expect(state(undefined, [match(40), match(41)], null).passed).toBe(false)
    expect(state(undefined, [match(41), playoff(1)], null).passed).toBe(true)
    expect(state('Q40', [match(40)], null).passed).toBe(true)
  })
  it('a playoff log is told by MatchType 3 or by its label, and only when it was on the field', () => {
    expect(isPlayoffLog({ onField: true, matchType: 3, matchLabel: '' })).toBe(true)
    expect(isPlayoffLog({ onField: true, matchType: null, matchLabel: 'Elimination 2' })).toBe(true)
    expect(isPlayoffLog({ onField: true, matchType: 2, matchLabel: 'Qualification 2' })).toBe(false)
    expect(isPlayoffLog({ onField: false, matchType: 3, matchLabel: 'Elimination 2' })).toBe(false)
  })
  it('the board reads the latest cut-off line of this event and ignores another event\'s', () => {
    const s = session([match(40), match(41)])
    expect(buildBoard(input(s)).cutOff.passed).toBe(true)
    expect(buildBoard(input(s, [cut('off', iso(1))])).cutOff).toMatchObject({ passed: false, words: 'off' })
    expect(buildBoard(input(s, [cut('off', iso(1)), cut('alliance-selection', iso(2))])).cutOff.passed).toBe(true)
    expect(buildBoard(input(s, [cut('off', iso(1), { event: 'ELSEWHERE' })])).cutOff.passed).toBe(true)
    expect(buildBoard(input(session([match(5)]))).cutOff.passed).toBe(false)
  })
  it('noteLine writes the cut-off as an event-note under the role, never a name', () => {
    const line = noteLine([], { device: 'dev-a', role: 'software' }, new Date(BASE), 'cut-off', 'TEST', 'Q5', 'Q40')
    expect(line).toMatchObject({ type: 'event-note', kind: 'cut-off', text: 'Q40', by: { device: 'dev-a', role: 'software' } })
    expect(parseHistory(serializeHistory([line])).events).toEqual([line])
  })
})

describe('the code change flag', () => {
  const passed = { passed: true }
  const last = (sha: string, uncommitted = false) => ({ label: 'Q41', build: { sha, uncommitted } })
  it('is nothing before the cut-off, and nothing without an on-field match to compare with', () => {
    expect(codeChangeFlag({ passed: false }, { sha: 'bbbbbbb', dirty: false }, last('aaaaaaa'))).toBeNull()
    expect(codeChangeFlag(passed, { sha: 'bbbbbbb', dirty: false }, undefined)).toBeNull()
  })
  it('flags a different commit, amber, with both commits named', () => {
    const f = codeChangeFlag(passed, { sha: 'bbbbbbb1234567', dirty: false }, last('aaaaaaa'))!
    expect(f).toMatchObject({ kind: 'changed', amber: true, from: 'aaaaaaa', to: 'bbbbbbb1234567' })
    expect(f.text).toBe('Code changed since Q41: the robot runs bbbbbbb, Q41 ran aaaaaaa.')
  })
  it('a different commit that is also dirty says so', () => expect(codeChangeFlag(passed, { sha: 'bbbbbbb', dirty: true }, last('aaaaaaa'))!.text).toContain('uncommitted changes'))
  it('flags uncommitted changes on the same commit, on either side', () => {
    expect(codeChangeFlag(passed, { sha: 'aaaaaaa', dirty: true }, last('aaaaaaa'))).toMatchObject({ kind: 'uncommitted', amber: true })
    expect(codeChangeFlag(passed, { sha: 'aaaaaaa', dirty: false }, last('aaaaaaa', true))).toMatchObject({ kind: 'uncommitted', amber: true })
  })
  it('both dirty on the same commit cannot be compared, and says so rather than clearing it', () => {
    const f = codeChangeFlag(passed, { sha: 'aaaaaaa', dirty: true }, last('aaaaaaa', true))!
    expect(f).toMatchObject({ kind: 'uncommitted', amber: true })
    expect(f.text).toContain('cannot tell')
  })
  it('the same clean commit is not amber; a long hash and its 7-character prefix are the same commit', () => {
    expect(codeChangeFlag(passed, { sha: 'aaaaaaa0123456789', dirty: false }, last('AAAAAAA'))).toMatchObject({ kind: 'same', amber: false })
  })
  it('says it cannot tell when a side is not known, amber, never "same"', () => {
    expect(codeChangeFlag(passed, { sha: 'aaaaaaa', dirty: false }, { label: 'Q41' })).toMatchObject({ kind: 'unknown', amber: true })
    expect(codeChangeFlag(passed, { sha: 'aaaaaaa', dirty: false }, { label: 'Q41', build: { sha: '', uncommitted: false } })).toMatchObject({ kind: 'unknown', amber: true })
    expect(codeChangeFlag(passed, null, last('aaaaaaa'))).toMatchObject({ kind: 'unknown', amber: true })
    expect(codeChangeFlag(passed, { sha: '', dirty: false }, last('aaaaaaa'))).toMatchObject({ kind: 'unknown', amber: true })
  })
  it('works off the board: the last on-field log\'s build as the session summary holds it', () => {
    const s = session([withBuild(match(40), 'aaaaaaa'), withBuild(match(41), 'ccccccc')])
    const b = buildBoard(input(s))
    const lastLog = s.matches.at(-1)!
    expect(codeChangeFlag(b.cutOff, { sha: 'ddddddd', dirty: false }, { label: b.tl.last!.label, build: lastLog.build })).toMatchObject({ kind: 'changed', from: 'ccccccc', to: 'ddddddd' })
    expect(codeChangeFlag(buildBoard(input(session([match(5)]))).cutOff, { sha: 'ddddddd', dirty: false }, { label: 'Q5', build: { sha: 'ccccccc', uncommitted: false } })).toBeNull()
  })
})

describe('the queue checklist with the flag', () => {
  const base = { verdict: null, why: 'test not connected', profile, deferrals: [], deferralNote: null }
  it('carries the banner and the flag, and changes neither the word, the kind nor a row', () => {
    const plain = queueChecklist(base)
    const flag = codeChangeFlag({ passed: true }, { sha: 'bbbbbbb', dirty: false }, { label: 'Q41', build: { sha: 'aaaaaaa', uncommitted: false } })
    const flagged = queueChecklist({ ...base, freeze: { banner: FREEZE_BANNER, change: flag } })
    expect(plain.freeze).toBeNull()
    expect(flagged.freeze).toEqual({ banner: FREEZE_BANNER, change: flag })
    const { freeze: _a, ...a } = plain
    const { freeze: _b, ...b } = flagged
    expect(b).toEqual(a)
  })
})

describe('the files that changed between two commits', () => {
  const source = (trees: Record<string, Record<string, string>>): CodeSource => ({
    where: 'a test repo',
    resolve: async (ref) => { const full = Object.keys(trees).find((k) => k.startsWith(ref)); if (!full) throw new Error('missing'); return full },
    files: async (commit) => Object.entries(trees[commit]).map(([path, sha]) => ({ path, sha })),
    textAt: async () => '',
  })
  const repo = source({
    aaaaaaa1: { 'src/Robot.java': 'b1', 'src/Arm.java': 'b2', 'src/Old.java': 'b3' },
    bbbbbbb2: { 'src/Robot.java': 'b1', 'src/Arm.java': 'b9', 'src/New.java': 'b4' },
  })
  it('lists the added, removed and changed files, sorted, and nothing for the same commit', async () => {
    expect(await changedFiles(repo, 'aaaaaaa', 'bbbbbbb')).toEqual(['src/Arm.java', 'src/New.java', 'src/Old.java'])
    expect(await changedFiles(repo, 'aaaaaaa', 'aaaaaaa1')).toEqual([])
  })
  it('lets an unreadable commit through as an error, for the caller to word', async () => {
    await expect(changedFiles(repo, 'aaaaaaa', 'zzzzzzz')).rejects.toThrow('missing')
  })
})

describe('deferral suggestions after the cut-off', () => {
  const tl = timeline(session([match(5)]), SCHEDULE, label)
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
  it('before the cut-off, or for a red, they are exactly what they were', () => {
    const was = suggestions(tl)
    expect(suggestions(tl, { passed: false, red: false })).toEqual(was)
    expect(suggestions(tl, { passed: false, red: true })).toEqual(was)
    expect(was.find((s) => s.suggested)!.id).toBe('gap-7')
    expect(was.every((s) => s.reason === undefined)).toBe(true)
  })
  it('after it, for anything that is not red, the end of the event leads and is the pick; nothing is left out while it is mid-qualifications', () => {
    const was = suggestions(tl)
    const now = suggestions(tl, { passed: true, red: false })
    expect(now[0]).toMatchObject({ id: 'end', suggested: true, reason: 'after the cut-off' })
    expect(now.filter((s) => s.suggested)).toHaveLength(1)
    expect(ids(now).slice(1)).toEqual(ids(was).filter((i) => i !== 'end'))
    expect([...ids(now)].sort()).toEqual([...ids(was)].sort())
    expect(now.find((s) => s.id === 'end')!.until).toEqual({ kind: 'end-of-event' })
  })
  it('the board offers them by the issue\'s priority', () => {
    const s = session([withBuild(fired(40), 'aaaaaaa'), withBuild(fired(41), 'aaaaaaa')])
    const b = buildBoard(input(s))
    expect(b.cutOff.passed).toBe(true)
    const red = b.issues[0]
    expect(red.priority).toBe('red')
    expect(deferralOptions(b, red)[0].id).not.toBe('end')
    expect(deferralOptions(b, { ...red, priority: 'amber' })[0]).toMatchObject({ id: 'end', reason: 'after the cut-off' })
    expect(deferralOptions(b, { ...red, priority: 'low' })[0].id).toBe('end')
    const early = buildBoard(input(session([fired(5)])))
    expect(deferralOptions(early, { priority: 'amber' })[0].id).toBe('next')
  })
})

describe('fixes after the cut-off: reds only', () => {
  it('a fix is folded after the cut-off unless the finding is red', () => {
    expect(fixFolded(true, 'amber')).toBe(true)
    expect(fixFolded(true, 'low')).toBe(true)
    expect(fixFolded(true, 'red')).toBe(false)
    expect(fixFolded(false, 'amber')).toBe(false)
    expect(fixFolded(false, 'red')).toBe(false)
  })
})

describe('"still holds?" on each open deferral', () => {
  const matches = [fired(40), fired(41)]
  const defer = (when: string, o: Partial<BoardEvent> = {}): BoardEvent[] => [
    bl('workaround', 'test workaround', when, o), bl('defer', 'end-of-event', when, { until: { kind: 'end-of-event' }, ...o }),
  ]
  const at = (history: HistoryEvent[], min: number): BoardIssue => buildBoard({ ...input(session(matches), history), now: new Date(BASE + min * 60e3) }).issues.find((i) => i.key === KEY)!
  it('has no tick until one is made; a tick records the role and time', () => {
    const h = defer(iso(900))
    expect(at(h, 905).status).toBe('deferred')
    expect(at(h, 905).holds).toBeNull()
    const t = at([...h, bl('checked', HOLDS, iso(910), { by: { device: 'dev-b', role: 'drive' } })], 920).holds!
    expect(t).toMatchObject({ role: 'drive', when: iso(910), old: false })
  })
  it('is fresh for 90 minutes, then old', () => {
    const h = [...defer(iso(900)), bl('checked', HOLDS, iso(910))]
    expect(at(h, 910 + 90).holds!.old).toBe(false)
    expect(at(h, 910 + 91).holds!.old).toBe(true)
  })
  it('a tick made before the deferral does not answer for it', () => {
    const h = [bl('checked', HOLDS, iso(890)), ...defer(iso(900))]
    expect(at(h, 905).holds).toBeNull()
  })
  it('the tick is scoped to the event: another event\'s does not count', () => {
    const h = [...defer(iso(900)), bl('checked', HOLDS, iso(910), { event: 'ELSEWHERE' })]
    expect(at(h, 915).holds).toBeNull()
  })
  it('an unchecked line takes it back; a queue-sheet tick for a match is not a "still holds" tick', () => {
    const h = [...defer(iso(900)), bl('checked', HOLDS, iso(910)), bl('unchecked', HOLDS, iso(912))]
    expect(at(h, 915).holds).toBeNull()
    expect(at([...defer(iso(900)), bl('checked', 'Q42', iso(910))], 915).holds).toBeNull()
  })
  it('a holds tick is not a queue-sheet tick: it does not clear the gate', () => {
    const i = at([...defer(iso(900)), bl('checked', HOLDS, iso(910))], 915)
    expect(i.checked.map((c) => c.match)).toEqual([HOLDS])
    expect(buildBoard({ ...input(session(matches), [...defer(iso(900)), bl('checked', HOLDS, iso(910))]), now: new Date(BASE + 915 * 60e3) }).tickFor).not.toBe(HOLDS)
  })
  it('an issue with no live deferral has no tick to read', () => {
    expect(at([bl('checked', HOLDS, iso(910))], 915).holds).toBeNull()
  })
})

describe('no deferral point already in the past (UX)', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
  it('kept while that gap is still ahead: cut-off after Q5, a schedule, mid-qualifications', () => {
    const tl = timeline(session([match(5)]), SCHEDULE, label)
    for (const red of [true, false]) expect(ids(suggestions(tl, { passed: true, red }))).toContain('playoffs')
  })
  it('dropped once it is behind: after the team\'s last qualification', () => {
    const tl = timeline(session([match(40), match(41)]), SCHEDULE, label)
    expect(ids(suggestions(tl))).toContain('playoffs')
    for (const red of [true, false]) expect(ids(suggestions(tl, { passed: true, red }))).not.toContain('playoffs')
    expect(ids(suggestions(tl, { passed: false, red: true }))).toContain('playoffs')
  })
  it('dropped with no schedule', () => {
    const tl = timeline(session([match(5)]), null, label)
    for (const red of [true, false]) expect(ids(suggestions(tl, { passed: true, red }))).not.toContain('playoffs')
  })
  it('a red keeps its pick (the next named gap, else the next match) among the rest', () => {
    const tl = timeline(session([match(5)]), SCHEDULE, label)
    const red = suggestions(tl, { passed: true, red: true })
    expect(red.filter((s) => s.suggested).map((s) => s.id)).toEqual(['gap-7'])
    expect(red[0].reason).toBeUndefined()
    const none = suggestions(timeline(session([match(5)]), null, label), { passed: true, red: true })
    expect(none.find((s) => s.suggested)!.id).toBe('next')
  })
})

describe('the strip counts deferrals to re-confirm', () => {
  const matches = [fired(40), fired(41)]
  const dfr = [bl('workaround', 'test workaround', iso(900)), bl('defer', 'end-of-event', iso(900), { until: { kind: 'end-of-event' } })]
  const strip = (h: HistoryEvent[], min: number) => buildBoard({ ...input(session(matches), h), now: new Date(BASE + min * 60e3) }).strip.reconfirm
  it('is 0 before the cut-off, 1 for an open deferral with no tick, 0 with a fresh tick, 1 again when it is old', () => {
    expect(buildBoard({ ...input(session([fired(5)]), dfr.map((l) => ({ ...l }))), now: new Date(BASE + 905 * 60e3) }).strip.reconfirm).toBe(0)
    expect(strip(dfr, 905)).toBe(1)
    const ticked = [...dfr, bl('checked', HOLDS, iso(910))]
    expect(strip(ticked, 915)).toBe(0)
    expect(strip(ticked, 910 + 91)).toBe(1)
  })
})

describe('the schedule read both views share', () => {
  const qm = (...numbers: number[]) => numbers.map((n) => ({ key: `2099x_qm${n}`, comp_level: 'qm', set_number: 1, match_number: n, time: 1_000_000 + n * 600 }))
  const EVENTS = [{ key: '2099test', name: 'Test Regional', start_date: '2099-03-05', end_date: '2099-03-07' }]
  const fakeFetch = (down = false): typeof fetch => (async (url: string) => {
    if (down) throw new TypeError('network down')
    const path = url.replace('https://www.thebluealliance.com/api/v3', '')
    const body = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response
    let m
    if ((m = /^\/team\/frc9999\/events\/(\d{4})\/simple$/.exec(path))) return body(m[1] === '2099' ? EVENTS : [])
    if (/^\/event\/\w+$/.test(path)) return body({ ...EVENTS[0], timezone: 'America/Los_Angeles' })
    if (/^\/team\/frc9999\/event\/\w+\/matches\/simple$/.test(path)) return body(qm(2, 3, 4, 5, 6))
    return { ok: false, status: 404, json: async () => null } as Response
  }) as unknown as typeof fetch
  const get = (down = false) => createTba({ key: 'k'.repeat(64), store: memoryStore(), fetch: fakeFetch(down), now: () => 7 })
  it('returns the team\'s schedule and a line saying where it came from', async () => {
    const got = await sessionSchedule(session([match(2), match(3), match(4)]), 9999, get())
    expect(got.schedule?.map((m) => m.number)).toEqual([2, 3, 4, 5, 6])
    expect(got.note).toMatch(/^Schedule for 2099test( from a saved copy)? as of /)
  })
  it('says why there is none: numbers no event holds, or offline with no saved copy; it never throws', async () => {
    const a = await sessionSchedule(session([match(20), match(21)]), 9999, get())
    expect(a.schedule).toBeNull()
    expect(a.note).toMatch(/^No schedule: .*no event on the team's list/)
    const b = await sessionSchedule(session([match(2), match(3)]), 9999, get(true))
    expect(b.schedule).toBeNull()
    expect(b.note).toMatch(/^No schedule: /)
  })
  it('with the schedule, the cut-off default passes on the last scheduled qualification and the board reads match numbers', async () => {
    const got = await sessionSchedule(session([match(5), match(6)]), 9999, get())
    const b = buildBoard(input(session([match(5), match(6)]), [], got.schedule))
    expect(b.cutOff.passed).toBe(true)
    expect(buildBoard(input(session([match(5), match(6)]), [], null)).cutOff.passed).toBe(false)
  })
})

describe('one headline per event: the flag does not repeat what the Code row says', () => {
  const PROVEN = { 'build/dirty': { logs: 9, fires: 1, ourFires: 1, base: 'test', date: '2099-03-05' } }
  const dirty = { rule: 'build/dirty', severity: 'error', title: 'test finding build/dirty', time: null, matchTime: null, when: null, about: null, key: 'build/dirty', evidence: {}, meaning: '', causes: [], nextStep: 'test step' }
  const withDirty = verdictFor({ findings: [dirty], skipped: [], crashed: [] } as unknown as Report, PROVEN as never)
  const clean = verdictFor({ findings: [], skipped: [], crashed: [] } as unknown as Report, PROVEN as never)
  const base = { why: 'test', profile, deferrals: [], deferralNote: null }
  const last = { label: 'Q41', build: { sha: 'aaaaaaa', uncommitted: false } }
  const flag = (live: { sha: string; dirty: boolean }) => codeChangeFlag({ passed: true }, live, last)
  const run = (v: typeof withDirty, f: ReturnType<typeof flag>) => queueChecklist({ ...base, verdict: v, freeze: { banner: FREEZE_BANNER, change: f } }).freeze!.change
  it('a changed commit that is also dirty loses its "uncommitted" clause when the Code row has it, keeps it otherwise', () => {
    const f = flag({ sha: 'bbbbbbb', dirty: true })
    expect(f!.text).toContain('uncommitted changes')
    expect(run(withDirty, f)!.text).toBe('Code changed since Q41: the robot runs bbbbbbb, Q41 ran aaaaaaa.')
    expect(run(clean, f)!.text).toContain('uncommitted changes')
  })
  it('uncommitted changes only on the robot: the flag is dropped when the Code row says it, kept otherwise', () => {
    const f = flag({ sha: 'aaaaaaa', dirty: true })
    expect(run(withDirty, f)).toBeNull()
    expect(run(clean, f)).toEqual(f)
  })
  it('both dirty (cannot compare) and a plain change are kept', () => {
    const both = codeChangeFlag({ passed: true }, { sha: 'aaaaaaa', dirty: true }, { label: 'Q41', build: { sha: 'aaaaaaa', uncommitted: true } })
    expect(run(withDirty, both)).toEqual(both)
    const moved = flag({ sha: 'bbbbbbb', dirty: false })
    expect(run(withDirty, moved)).toEqual(moved)
  })
})
