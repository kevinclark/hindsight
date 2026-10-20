import { describe, expect, it } from 'vitest'
import { triage, type IssueEvent } from '../src/triage/history.ts'
import { demotion, howSure, matchRef, shortMatch, trackRecord, withMarks, wrongHere } from '../src/triage/track-record.ts'
import { playedAt, reviewModel } from '../src/report/review-model.ts'
import type { Finding } from '../src/rules/types.ts'
import { analyzeFixture } from './helpers/load.ts'

// Invented event, matches and reasons: the team's real labels live only in its history file.
const RULE = 'auto/early-disable'
const finding = (key: string, severity: Finding['severity'] = 'error'): Finding => ({
  rule: key.split(' · ')[0], severity, title: key, time: 1, matchTime: 1, when: null, about: null, key, evidence: {}, meaning: '', causes: [], nextStep: '',
})
const played = Date.parse('2026-10-17T17:00:00Z')
const q = (n: number) => `TEST Qualification ${n}`
const q7 = { id: q(7), event: 'TEST', played }
const mark = (status: IssueEvent['status'], match: string, more: Partial<IssueEvent> = {}): IssueEvent => ({
  type: 'issue', key: RULE, status, note: status === 'wrong' ? 'test reason' : '', when: '2026-10-20T10:00:00Z', match, event: 'TEST', played: '2026-10-17T15:00:00Z', ...more,
})
const q2wrong = mark('wrong', q(2))
const fire = (key: string, match: string, at: number | null = played) => ({ key, match, played: at })

describe('track record', () => {
  it('counts real only where someone marked that match; other fires of a known issue are "known", not confirmed', () => {
    const events = [mark('known', q(13)), q2wrong, mark('wrong', q(9), { key: `${RULE} · x` })]
    const fires = [fire(RULE, q(13)), fire(RULE, q(13)), fire(RULE, q(37)), fire('other/rule', q(37))]
    // Q13 marked known (real), Q37 fired on the known issue (known), Q2 and Q9 wrong.
    expect(trackRecord(RULE, triage(events), events, fires)).toEqual({ fired: 4, real: 1, known: 1, wrong: 2, untriaged: 0 })
    expect(trackRecord(RULE, triage(events), events, [fire(`${RULE} · y`, q(40))]).untriaged).toBe(1)
  })
  it('a fire after a fix is not counted as confirmed (it came back); one before the fix is a known issue', () => {
    const fixed = [mark('fixed', q(13), { when: '2026-10-18T00:00:00Z' })]
    const t = triage(fixed)
    expect(trackRecord(RULE, t, fixed, [fire(RULE, q(40), Date.parse('2026-10-19T00:00:00Z'))])).toEqual({ fired: 2, real: 1, known: 0, wrong: 0, untriaged: 1 })
    expect(trackRecord(RULE, t, fixed, [fire(RULE, q(5), Date.parse('2026-10-17T00:00:00Z'))]).known).toBe(1)
  })
  it('an undone wrong mark counts as not marked, never as real', () => {
    const events = [q2wrong, mark('unmark', q(2), { when: '2026-10-21T00:00:00Z' })]
    expect(trackRecord(RULE, triage(events), events, [])).toEqual({ fired: 1, real: 0, known: 0, wrong: 0, untriaged: 1 })
  })
  it('says nothing with no marks at all, and never calls a check confirmed when no mark says so', () => {
    const r = (o: Partial<{ fired: number; real: number; known: number; wrong: number; untriaged: number }>) => ({ fired: 0, real: 0, known: 0, wrong: 0, untriaged: 0, ...o })
    expect(howSure(r({ fired: 3, untriaged: 3 }), false)).toBeNull()
    expect(howSure(r({ fired: 3, untriaged: 3 }), true)).toBe('New check: never confirmed on our matches (fired 3 times: 3 not marked yet)')
    expect(howSure(r({}), true)).toBe('New check: never confirmed on our matches')
    expect(howSure(r({ fired: 6, real: 5, wrong: 1 }), true)).toBe('marked real on 5 of the 6 times it fired on our matches; 1 marked not a real problem')
    expect(howSure(r({ fired: 5, real: 1, known: 3, untriaged: 1 }), true)).toBe('marked real on 1 of the 5 times it fired on our matches; a known issue on 3 more; 1 not marked yet')
  })
  it('names the match short, without the event; a log with no match label is named by its file', () => {
    expect(shortMatch(q2wrong)).toBe('Q2')
    expect(shortMatch({ ...q2wrong, event: undefined, match: 'akit_26-10-17_p0.wpilog' })).toBe('akit_26-10-17_p0.wpilog')
    expect(matchRef({ event: 'TEST', matchLabel: '', fileName: 'a.wpilog' }, null).id).toBe('a.wpilog')
    expect(matchRef({ event: 'TEST', matchLabel: 'Qualification 7', fileName: 'a.wpilog' }, null).id).toBe(q(7))
  })
})

describe('a wrong mark demotes the check for its event', () => {
  const t = triage([q2wrong])
  it('turns the same check\'s red amber on another match of the same event', () => {
    expect(demotion(finding(RULE), q7, t)).toEqual(q2wrong)
    expect(demotion(finding(`${RULE} · intake`), q7, t)).toEqual(q2wrong)
  })
  it('leaves alone: other checks, ambers, the marked match itself, other events, next year, undated logs', () => {
    expect(demotion(finding('comms/loss'), q7, t)).toBeUndefined()
    expect(demotion(finding(RULE, 'warning'), q7, t)).toBeUndefined()
    expect(demotion(finding(RULE), { ...q7, id: q(2) }, t)).toBeUndefined()
    expect(demotion(finding(RULE), { ...q7, event: 'OTHER' }, t)).toBeUndefined()
    expect(demotion(finding(RULE), { ...q7, played: played + 365 * 86400e3 }, t)).toBeUndefined()
    expect(demotion(finding(RULE), { ...q7, played: null }, t)).toBeUndefined()
    expect(demotion(finding(RULE), { ...q7, event: '' }, t)).toBeUndefined()
  })
  it('stops once the mark is undone or the issue is marked known', () => {
    expect(demotion(finding(RULE), q7, triage([q2wrong, mark('unmark', q(2), { when: '2026-10-21T00:00:00Z' })]))).toBeUndefined()
    expect(demotion(finding(RULE), q7, triage([q2wrong, mark('known', q(13), { when: '2026-10-21T00:00:00Z' })]))).toBeUndefined()
  })
  it('still demotes a red that came back after a fix: the fix may be fine and the check wrong', () => {
    const fixedBefore = mark('fixed', q(1), { when: '2026-10-16T00:00:00Z' })
    expect(demotion(finding(RULE), q7, triage([fixedBefore, q2wrong]))).toEqual(q2wrong)
  })
})

describe('marks on a real match (CalGames Q13 fixture)', () => {
  const q13 = analyzeFixture('q13-auto-and-comms').analyses[0]
  const here = matchRef(q13.match, playedAt(q13))
  const red = q13.report.findings.find((f) => f.severity === 'error')!
  const other = (when: number | null) => ({ type: 'issue' as const, key: red.key, status: 'wrong' as const, note: 'test reason', when: '2026-10-20T00:00:00Z',
    match: `${here.event} Qualification 99`, event: here.event, played: when === null ? undefined : new Date(when).toISOString() })
  it('the fixture is an on-field match with an event and a date (else nothing below is tested)', () => {
    expect(here.event).not.toBe('')
    expect(here.played).not.toBeNull()
  })
  it('with no wrong marks the analysis is the same object: nothing changes without a history', () => {
    expect(withMarks(q13, here, triage([]))).toBe(q13)
    expect(withMarks(q13, here, triage([{ ...other(here.played), status: 'known' }]))).toBe(q13)
  })
  it('a wrong mark on another match of the event turns this red amber, with the reason, among the warnings', () => {
    const shown = withMarks(q13, here, triage([other(here.played)]))
    const f = shown.report.findings.find((x) => x.key === red.key && x.time === red.time)!
    expect(f.severity).toBe('warning')
    expect(f.demoted).toEqual({ match: 'Q99', reason: 'test reason', when: '2026-10-20T00:00:00Z' })
    expect(red.severity).toBe('error') // the log's own analysis is untouched
    const sev = shown.report.findings.map((x) => x.severity)
    expect(sev.lastIndexOf('error')).toBeLessThan(sev.indexOf('warning'))
    const before = reviewModel(q13, new Map())
    const after = reviewModel(shown, new Map())
    const reds = (m: typeof before) => m.errors.filter((x) => x.rule === red.rule).length
    expect(reds(after)).toBe(0)
    expect(after.errors.length).toBe(before.errors.length - reds(before))
    expect(after.active.length).toBe(before.active.length)
  })
  it('a wrong mark on this match files the finding with the known issues, out of the active list', () => {
    const t = triage([{ ...other(here.played), match: here.id }])
    const m = reviewModel(withMarks(q13, here, t), new Map(), wrongHere(here, t))
    expect(m.known.map((f) => f.key)).toContain(red.key)
    expect(m.active.map((f) => f.key)).not.toContain(red.key)
  })
})

describe('a red parent whose members are all demoted is demoted with them', () => {
  const q13 = analyzeFixture('q13-auto-and-comms').analyses[0]
  const here = matchRef(q13.match, playedAt(q13))
  const by = { rule: 'test/parent', about: null, time: 1, why: 'test' }
  const member = (key: string): Finding => ({ ...finding(key), explainedBy: by })
  const parent: Finding = { ...finding('test/parent'), time: 1 }
  const wrongOn = (rule: string) => ({ type: 'issue' as const, key: rule, status: 'wrong' as const, note: 'test reason', when: '2026-10-20T00:00:00Z',
    match: `${here.event} Qualification 99`, event: here.event, played: new Date(here.played!).toISOString() })
  const withGroup = (findings: Finding[]) => ({ ...q13, report: { ...q13.report, findings, parents: [parent] } })
  it('all members demoted: the parent is amber too, citing the same mark', () => {
    const shown = withMarks(withGroup([member(`${RULE} · a`), member(`${RULE} · b`)]), here, triage([wrongOn(RULE)]))
    expect(shown.report.parents![0].severity).toBe('warning')
    expect(shown.report.parents![0].demoted?.match).toBe('Q99')
  })
  it('one member still red: the parent stays red', () => {
    const shown = withMarks(withGroup([member(`${RULE} · a`), member('comms/loss')]), here, triage([wrongOn(RULE)]))
    expect(shown.report.parents![0].severity).toBe('error')
  })
})
