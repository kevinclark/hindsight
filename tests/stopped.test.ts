// A session says when a finding stopped firing: the student's fixed mark first, else "not seen since" with the exact
// chance of a run that clean with no fix. Invented TEST matches only.
import { describe, expect, it } from 'vitest'
import { chanceText, cleanRunChance, notSeenSince, sinks, stoppedFiring, stoppedText } from '../src/session/stopped.ts'
import { mergeFindings, type Session } from '../src/session/session.ts'
import type { MatchSummary, RuleStatus } from '../src/session/summary.ts'
import { bottomLine, sessionCard, sessionModel } from '../src/report/session-model.ts'
import { buildSessionJson } from '../src/session/export.ts'
import type { IssueEvent } from '../src/triage/history.ts'

const RULE = 'power/rest-voltage'
const HOUR = 3600e3
const START = Date.UTC(2030, 0, 5, 9)
const STATUS: Record<string, RuleStatus> = { X: 'fired', '.': 'quiet', '-': 'not checked' }

/**
 * A TEST session from a row of cells ("XX-.."): X fired, . quiet, - not checked. One match an hour, labelled
 * "Qualification 1", 2, …; `shas` gives each log's build (default: all the same).
 */
function session(cells: string, opts: { severity?: 'error' | 'warning'; shas?: string[]; about?: string } = {}): Session {
  const matches = [...cells].map((c, i): MatchSummary => {
    const status = STATUS[c]
    const key = opts.about ? `${RULE} · ${opts.about}` : RULE
    const findings = status === 'fired' ? [{ rule: RULE, key, about: opts.about ?? null, severity: opts.severity ?? 'warning', title: 'test reason', time: null, matchTime: null, when: null, evidence: {}, likely: [], ruledOut: {} }] : []
    return {
      fileName: `TEST_${i + 1}.wpilog`, playedAt: START + i * HOUR, event: 'TEST', matchLabel: `Qualification ${i + 1}`, onField: true,
      build: { sha: opts.shas?.[i] ?? 'aaaaaaa', branch: 'main', uncommitted: false },
      rules: { [RULE]: { status, findings } },
      fileSize: 1, playedAtSource: 'robot clock', clockNote: null, batteryId: null, problems: [], timing: { parseMs: 0, rulesMs: 0 },
      metrics: { minVolts: null, secondsUnder7: null, chargeAh: null, resistanceMilliohms: null, followerSecondsOff: null, brownoutVolts: null, loopOverrunPct: null, visionOutlierPct: null },
      robot: { profileId: 'TEST @ main', name: 'TEST', code: { repo: 'TEST', branch: 'main', sha: 'aaaaaaa' }, how: 'signals', note: null, present: 1, total: 1 },
    } as unknown as MatchSummary
  })
  return { id: 'event:TEST', label: 'Event TEST', kind: 'event', matches }
}

const fixed = (when: number, key = RULE): IssueEvent => ({ type: 'issue', key, status: 'fixed', note: 'test reason', when: new Date(when).toISOString() })

describe('the chance of a run this clean with no fix, C(n, k) / C(N, k)', () => {
  it.each([
    ['XXXX...', 0.029, 1, 35],
    ['X......', 0.143, 1, 7],
    ['X.X....', 0.143, 1, 7],
    ['..X....', 0.429, 3, 7],
    ['...X...', 0.571, 4, 7],
  ] as const)('%s: %f (%i in %i)', (cells, value, times, outOf) => {
    const s = notSeenSince(session(cells), RULE)!
    expect(+s.chance.toFixed(3)).toBe(value)
    expect([s.times, s.outOf]).toEqual([times, outOf])
    expect(s.potentiallyFixed).toBe(value <= 0.05)
  })
  it('is exact at the 0.05 line: 1 firing then 19 clean is 1 in 20, potentially fixed; 1 in 19 is not', () => {
    expect(cleanRunChance(1, 1, 20)).toMatchObject({ times: 1, outOf: 20, potentiallyFixed: true })
    expect(cleanRunChance(1, 1, 19)).toMatchObject({ times: 1, outOf: 19, potentiallyFixed: false })
  })
  it('stays exact with many matches', () => {
    // 30 firings in the first 30 of 200: C(30, 30) / C(200, 30), far below 1e-30.
    const big = cleanRunChance(30, 30, 200)
    expect(big.potentiallyFixed).toBe(true)
    expect(big.chance).toBeGreaterThan(0)
    expect(big.chance).toBeLessThan(1e-30)
    expect(chanceText(big)).toBe('fewer than 1 time in a billion')
    // 4 firings in the first 4 of 30: 1 in 27,405.
    expect(chanceText(cleanRunChance(4, 4, 30))).toBe('about 1 time in 27,405')
  })
  it('reads "a run this clean happens 1 time in 35 with no fix"', () => {
    const s = session('XXXX...')
    expect(stoppedText(s, notSeenSince(s, RULE)!)).toBe('Potentially fixed: not seen since Q4 · 3 clean checked matches · a run this clean happens 1 time in 35 with no fix')
    const t = session('..X....')
    expect(stoppedText(t, notSeenSince(t, RULE)!)).toBe('Not seen since Q3 · 4 clean checked matches · a run this clean happens 3 times in 7 with no fix')
  })
})

describe('the run is the rule\'s own row', () => {
  it('a row whose own issue last fired earlier than the rule says so', () => {
    const s = session('XX.X...', { about: 'TEST item' })
    // Match 4 fired for another item of the same rule.
    s.matches[3].rules[RULE].findings = [{ ...s.matches[0].rules[RULE].findings[0], key: `${RULE} · other`, about: 'other' }]
    const f = mergeFindings(s).find((x) => x.key === `${RULE} · TEST item`)!
    expect(stoppedText(s, notSeenSince(s, RULE)!, f)).toMatch(/^Not seen since Q4 \(this one last in Q2\) · 3 clean checked matches/)
  })
})

describe('"not seen since" needs at least 2 clean checked matches after the last firing', () => {
  it('2 clean: labelled; 1 clean or still firing: not', () => {
    expect(notSeenSince(session('XXXXX..'), RULE)?.clean).toBe(2)
    expect(notSeenSince(session('XXXXXX.'), RULE)).toBeNull()
    expect(notSeenSince(session('X.....X'), RULE)).toBeNull()
    expect(notSeenSince(session('.......'), RULE)).toBeNull()
  })
  it('skips matches the rule could not check: they are neither clean nor counted', () => {
    // Checked: X . . (N = 3), last firing at 1: 1 in 3, with 2 clean.
    const s = notSeenSince(session('X-.-.'), RULE)!
    expect([s.clean, s.times, s.outOf]).toEqual([2, 1, 3])
    // Only 1 checked match after the firing: no label, however many were not checked.
    expect(notSeenSince(session('X.---'), RULE)).toBeNull()
  })
})

describe('only a potentially fixed warning sinks; an error never does', () => {
  it('a warning at 1 in 35 sinks, an error at 1 in 35 stays', () => {
    const s = notSeenSince(session('XXXX...'), RULE)
    expect(sinks(s, 'warning')).toBe(true)
    expect(sinks(s, 'error')).toBe(false)
    expect(sinks(notSeenSince(session('X......'), RULE), 'warning')).toBe(false) // 1 in 7: labelled, not sunk
  })
  it('the report sorts the sunk warning last and puts it in a "Stopped" group of the bottom line; the error stays', () => {
    const warn = sessionModel(session('XXXX...'))
    expect(warn.findings[0]).toMatchObject({ sinks: true, stoppedShort: 'not seen since Q4, 1\u00a0in\u00a035' })
    expect(warn.bottomLine).toMatch(/Stopped: Battery not fully charged, not seen since Q4, 1\u00a0in\u00a035\.$/)
    expect(warn.bottomLine).not.toMatch(/Consistent|Intermittent/)
    const err = sessionModel(session('XXXX...', { severity: 'error' }))
    expect(err.findings[0]).toMatchObject({ sinks: false, stopped: expect.stringMatching(/^Potentially fixed: not seen since Q4/) })
    expect(err.bottomLine).toMatch(/Consistent: Battery not fully charged, 4 of 7\.$/)
  })
  it('the phone card shows potentially fixed for an error too, and a fixed mark; plain "not seen since" stays off', () => {
    const errCard = sessionCard(sessionModel(session('XXXX...', { severity: 'error' }))).items[0]
    expect(errCard.word).toMatch(/^ERROR · CONSISTENT · POTENTIALLY FIXED$/)
    expect(errCard.number).toMatch(/ · potentially fixed: not seen since Q4, 1\u00a0in\u00a035$/)
    expect(sessionCard(sessionModel(session('X......'))).items[0].number).not.toMatch(/seen since|fixed/)
    const marked = session('XX.....')
    const card = sessionCard(sessionModel(marked, new Map([[RULE, fixed(START + 3.5 * HOUR)]]))).items[0]
    expect(card.number).toMatch(/ · marked fixed after Q4, quiet in 3 since$/)
  })
  it('bottomLine: live findings first, then the stopped ones', () => {
    const f = (ruleTitle: string, confidence: 'consistent' | 'once', sunk: boolean) => ({ ruleTitle, confidence, ratio: '3 of 7', sinks: sunk, stoppedShort: sunk ? 'not seen since Q3, 1 in 35' : '' }) as never
    expect(bottomLine(7, [f('A', 'consistent', false), f('B', 'consistent', true)])).toBe('7 matches. Consistent: A, 3 of 7. Stopped: B, not seen since Q3, 1 in 35.')
  })
})

describe("a student's fixed mark leads, and counts only matches after its time", () => {
  it('counts the quiet matches played after the mark, never the ones before it', () => {
    // Fired in matches 1–2, marked fixed between match 4 and 5: matches 5–7 count (3), not 3–4.
    const s = session('XX.....')
    const stop = stoppedFiring(s, mergeFindings(s)[0], fixed(START + 3.5 * HOUR))!
    expect(stop).toMatchObject({ kind: 'fixed mark', before: 3, quiet: 3 })
    expect(stoppedText(s, stop)).toBe('Marked fixed after Q4 · quiet in 3 checked matches since')
  })
  it('no statistics with a mark, and a not-checked match after it is not counted', () => {
    const s = session('XX..-..')
    const text = stoppedText(s, stoppedFiring(s, mergeFindings(s)[0], fixed(START + 1.5 * HOUR))!)
    expect(text).toBe('Marked fixed after Q2 · quiet in 4 checked matches since')
    expect(text).not.toMatch(/time in/)
  })
  it('says nothing when it fired again after the mark (the view says "came back after a fix")', () => {
    const s = session('XX...X.')
    expect(stoppedFiring(s, mergeFindings(s)[0], fixed(START + 1.5 * HOUR))).toBeNull()
  })
  it('a mark with no checked match since says so', () => {
    const s = session('XX.----')
    expect(stoppedText(s, stoppedFiring(s, mergeFindings(s)[0], fixed(START + 2.5 * HOUR))!)).toBe('Marked fixed after Q3 · no match checked since')
  })
  it('counts per issue: a match where the rule fired for something else, or skipped this item, is not this one firing', () => {
    const s = session('XX.....', { about: 'TEST item' })
    // Match 5: the rule fired, but for another item. Match 6: it skipped this item ("partly checked").
    s.matches[4].rules[RULE] = { status: 'fired', findings: [{ ...s.matches[0].rules[RULE].findings[0], key: `${RULE} · other`, about: 'other' }] }
    s.matches[5].rules[RULE] = { status: 'quiet', reason: 'partly checked; TEST item: test reason', findings: [] }
    const f = mergeFindings(s).find((x) => x.key === `${RULE} · TEST item`)!
    expect(stoppedFiring(s, f, fixed(START + 1.5 * HOUR, f.key))).toMatchObject({ quiet: 4 })
  })
})

describe('code changed in between: the log builds of the last firing and the next clean match', () => {
  it('adds "code changed in between: abc1234 → def5678" when they differ', () => {
    const s = session('XXXX...', { shas: ['abc1234', 'abc1234', 'abc1234', 'abc1234', 'def5678', 'def5678', 'def5678'] })
    expect(stoppedText(s, notSeenSince(s, RULE)!)).toMatch(/ · code changed in between: abc1234 → def5678$/)
    expect(stoppedText(session('XXXX...'), notSeenSince(session('XXXX...'), RULE)!)).not.toMatch(/code changed/)
  })
})

describe('the Session view, the report and the JSON say the same', () => {
  it('the JSON carries the stopped line and its numbers', () => {
    const s = session('XXXX...')
    const json = buildSessionJson(s) as { findings: { stopped?: Record<string, unknown> }[] }
    expect(json.findings[0].stopped).toMatchObject({
      kind: 'not seen', lastFired: 'TEST_4.wpilog', cleanAfter: 3, chance: { times: 1, outOf: 35 }, potentiallyFixed: true, sortsBelowLive: true,
      text: sessionModel(s).findings[0].stopped,
    })
    expect((buildSessionJson(session('XXXXXX.')) as { findings: object[] }).findings[0]).not.toHaveProperty('stopped')
  })
})
