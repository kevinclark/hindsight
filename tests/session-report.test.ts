// The Session report: the model behind the printed report and the phone card.
import { describe, expect, it } from 'vitest'
import { buildCard, CARD_MAX_HEIGHT, CARD_MIN_TYPE } from '../src/report/card.ts'
import { bottomLine, buildText, cameBack, gridModel, sessionBase, sessionCard, sessionModel, trendsModel } from '../src/report/session-model.ts'
import { TREND_METRICS } from '../src/session/trends.ts'
import { groupSessions, mergeFindings, type Session } from '../src/session/session.ts'
import { summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import type { IssueEvent } from '../src/triage/history.ts'
import { joinPieces, summarizeMatch } from '../src/session/summary.ts'
import { buildSessionJson } from '../src/session/export.ts'
import { ONCE_FOLD_ABOVE, crashedNote } from '../src/report/session-model.ts'
import { analyzeFixture, CALGAMES, haveCalGames, readInput } from './helpers/load.ts'

const METRICS = { minVolts: 8, secondsUnder7: 0, chargeAh: 1, resistanceMilliohms: null, followerSpeedPct: 90, loopOverrunPct: 5, visionOutlierPct: null }
const fit = { profileId: 'p @ main', name: 'Test robot', code: { repo: 'r', branch: 'main', sha: 'abc1234def' }, how: 'signals', note: null, present: 40, total: 40 }
const finding = (key: string, rule: string, severity: string, title: string, value?: number) => ({
  key, rule, severity, title, when: null, evidence: {}, measured: value === undefined ? undefined : [{ label: 'slowest follower', value, unit: '%', threshold: 85 }],
})
type Fire = { key: string; rule: string; severity?: string; title: string; value?: number }
const match = (n: number, fires: Fire[], over: Partial<MatchSummary> = {}): MatchSummary => ({
  fileName: `q${n}.wpilog`, fileSize: 1, playedAt: Date.UTC(2026, 9, 17, 20 + n), playedAtSource: 'robot clock', clockNote: null, event: 'cacg',
  matchLabel: `Qualification ${n}`, onField: true, batteryId: null, build: { sha: 'abc1234', branch: 'main', uncommitted: false },
  rules: Object.fromEntries(['mech/follower-mismatch', 'power/brownout', 'loop/overrun'].map((r) => {
    const mine = fires.filter((f) => f.rule === r)
    return [r, { status: mine.length ? 'fired' : 'quiet', findings: mine.map((f) => finding(f.key, f.rule, f.severity ?? 'warning', f.title, f.value)) }]
  })),
  metrics: { ...METRICS, minVolts: 7 + n }, timing: { parseMs: 1, rulesMs: 1 }, problems: [], robot: fit, ...over,
} as unknown as MatchSummary)

const FOLLOW: Fire = { key: 'mech/follower-mismatch · Flywheel', rule: 'mech/follower-mismatch', title: 'Flywheel follower 18 ran off its leader (teleop; robot time 417.4 s)', value: 70 }
const BROWN: Fire = { key: 'power/brownout', rule: 'power/brownout', severity: 'error', title: 'Browned out 53 times' }
const three = (): Session => groupSessions([match(1, [FOLLOW, BROWN]), match(2, [{ ...FOLLOW, value: 80 }]), match(3, [FOLLOW])])[0]

describe('session report model', () => {
  const s = three()
  const m = sessionModel(s)
  it('says the match count, then confidence in words with "N of M"', () => {
    expect(m.matchCount).toBe(3)
    expect(m.bottomLine).toMatch(/^3 matches\./)
    const follow = m.findings.find((f) => f.key === FOLLOW.key)!
    expect(follow).toMatchObject({ confidence: 'consistent', confidenceWord: 'Consistent', ratio: '3 of 3', severity: 'warning', sevWord: 'Warning' })
    const brown = m.findings.find((f) => f.key === 'power/brownout')!
    expect(brown).toMatchObject({ confidence: 'once', confidenceWord: 'Once', ratio: '1 of 3', sevWord: 'Error' })
    expect(m.bottomLine).toContain('Consistent: Motors on one loop at different speeds, 3 of 3')
    expect(m.bottomLine).toContain('Once: roboRIO brownout, 1 of 3')
  })
  it('lists exactly the view\'s merged findings (never info), worst first, count equal', () => {
    const merged = mergeFindings(s)
    expect(m.findings.map((f) => f.key).sort()).toEqual(merged.map((f) => f.key).sort())
    // The report's own order: confidence first, so the consistent warning comes before the once-only error.
    expect(m.findings.map((f) => f.confidence)).toEqual(['consistent', 'once'])
  })
  it('titles lose the per-match robot-time aside; the range uses "line", never "limit"', () => {
    const follow = m.findings.find((f) => f.key === FOLLOW.key)!
    expect(follow.title).toBe('Flywheel follower 18 ran off its leader')
    expect(follow.measured).toBe('slowest follower 70–80 % (line 85 %, 18 % past it)')
    expect(follow.rateText).toBe('fired in 3 of 3 where it could be checked (44–100 %)')
    expect(m.findings.map((f) => `${f.measured} ${f.rateText}`).join(' ')).not.toMatch(/\blimit\b/i)
  })
  it('a fix recorded before a later match that fired again is "Came back after a fix", by match label', () => {
    const fixed: IssueEvent = { key: FOLLOW.key, status: 'fixed', when: new Date(Date.UTC(2026, 9, 17, 22, 30)).toISOString(), note: '' } as IssueEvent
    expect(cameBack(s, new Map([[FOLLOW.key, fixed]]), FOLLOW.key, [0, 1, 2])).toEqual(['Qualification 3'])
    expect(cameBack(s, new Map([[FOLLOW.key, { ...fixed, status: 'known' } as IssueEvent]]), FOLLOW.key, [0, 1, 2])).toEqual([])
    expect(sessionModel(s, new Map([[FOLLOW.key, fixed]])).findings.find((f) => f.key === FOLLOW.key)!.cameBack).toEqual(['Qualification 3'])
  })
  it('the grid has a column per match, rules that fired anywhere first, one symbol-able state per cell', () => {
    const g = gridModel(s)
    expect(g.columns.map((c) => c.label)).toEqual(['Qualification 1', 'Qualification 2', 'Qualification 3'])
    expect(new Set(g.columns.map((c) => c.id)).size).toBe(3)
    expect(g.rows[0]).toMatchObject({ rule: 'mech/follower-mismatch', cells: ['fired', 'fired', 'fired'], rate: 'Consistent: 3 of 3', firedAnywhere: true })
    const firstQuiet = g.rows.findIndex((r) => !r.firedAnywhere)
    expect(g.rows.slice(firstQuiet).every((r) => !r.firedAnywhere)).toBe(true)
    expect(g.rows.slice(0, firstQuiet).every((r) => r.firedAnywhere)).toBe(true)
    expect(g.rows.find((r) => r.rule === 'loop/overrun')!.cells).toEqual(['quiet', 'quiet', 'quiet'])
    expect(g.rows.some((r) => r.rate === 'not checked')).toBe(true)
  })
  it('names the file the same way the Download button does, made safe', () => {
    expect(m.jsonFile).toBe('event-cacg-2026-10-17.session-findings.json')
    expect(sessionBase('Event ../x/ (2026)!')).toBe('event-x-2026')
    expect(sessionBase('???')).toBe('session')
  })
  it('counts matches that ran uncommitted code, and says when a log recorded no build', () => {
    const dirty = groupSessions([match(1, [], { build: { sha: 'aaa1111', branch: 'main', uncommitted: true } }), match(2, [], { build: undefined }), match(3, [])])[0]
    const d = sessionModel(dirty)
    expect(d).toMatchObject({ uncommitted: 1, buildUnknown: 1 })
    expect(buildText(d)).toContain('1 of 3 matches ran UNCOMMITTED changes (aaa1111)')
    expect(buildText(d)).toContain('build not recorded in 1 of 3')
    expect(buildText(m)).not.toMatch(/UNCOMMITTED/)
  })
  it('bottom line with nothing to report', () => {
    expect(bottomLine(1, [])).toBe('1 match. No errors or warnings in any match.')
  })
})

describe('session trends', () => {
  const s = three()
  it('use the same metrics as the Trends component and one scale per number, the dashed line included', () => {
    const t = trendsModel(s.matches)
    expect(t.panels.map((p) => p.key)).toEqual(TREND_METRICS.map((x) => x.key))
    const volts = t.panels.find((p) => p.key === 'minVolts')!
    expect(volts.points).toHaveLength(3)
    expect(volts.lineY).not.toBeNull()
    expect(volts.range).toBe('8.00–10.00')
    // Higher is higher up the chart (smaller y), the line at 7 V sits below every point.
    expect(volts.points[2].y).toBeLessThan(volts.points[0].y)
    expect(volts.lineY!).toBeGreaterThan(volts.points[0].y)
    expect(t.panels.find((p) => p.key === 'visionOutlierPct')).toMatchObject({ points: [], range: 'not in these logs' })
  })
  it('batteries get a letter each, so identity never rests on colour; matches with none get no letter', () => {
    const t = trendsModel([match(1, [], { batteryId: 'B-17' }), match(2, [], { batteryId: 'B-02' }), match(3, [], { batteryId: 'B-17' }), match(4, [])], { 'q4.wpilog': '' })
    expect(t.batteries).toEqual([{ letter: 'A', id: 'B-17' }, { letter: 'B', id: 'B-02' }])
    expect(t.panels[0].points.map((p) => p.letter)).toEqual(['A', 'B', 'A', ''])
    expect(t.anyUnlabelled).toBe(true)
    // A typed battery counts the same as a logged one.
    expect(trendsModel([match(1, [])], { 'q1.wpilog': 'typed-1' }).panels[0].points[0].letter).toBe('A')
  })
})

describe('session phone card', () => {
  const m = sessionModel(three())
  const card = buildCard(sessionCard(m))
  it('heads with the match count and the counts by confidence', () => {
    const c = sessionCard(m)
    expect(c.heading).toBe('3 matches')
    expect(c.subheading).toBe('1 consistent · 1 once')
    expect(c.context).toContain('Event cacg')
  })
  it('items are the report\'s merged findings in the same order, as "SEVERITY · CONFIDENCE" with "N of M"', () => {
    const c = sessionCard(m)
    expect(c.items.map((i) => i.word)).toEqual(['WARNING · CONSISTENT', 'ERROR · ONCE'])
    expect(c.items[1].number).toBe('1 of 3 matches')
    expect(c.items[0].number).toBe('3 of 3 matches · slowest follower 70–80 % (line 85 %, 18 % past it)')
    expect(card.svg).toContain('ERROR · ONCE')
    expect(card.svg).toContain('3 of 3 matches')
    expect(card.height).toBeLessThanOrEqual(CARD_MAX_HEIGHT)
    expect(Math.min(...[...card.svg.matchAll(/font-size="(\d+)"/g)].map((x) => Number(x[1])))).toBeGreaterThanOrEqual(CARD_MIN_TYPE)
  })
  it('says "+N more in the PDF" when the list is long, and boxes uncommitted code', () => {
    const many: Fire[] = Array.from({ length: 30 }, (_, i) => ({ key: `loop/overrun · ${i}`, rule: 'loop/overrun', title: `Overrun number ${i}` }))
    const big = sessionModel(groupSessions([match(1, many, { build: { sha: 'aaa1111', branch: 'main', uncommitted: true } }), match(2, many), match(3, many)])[0])
    const c = buildCard(sessionCard(big))
    expect(c.hidden).toBeGreaterThan(0)
    expect(c.svg).toContain(`+${c.hidden} more in the PDF`)
    expect(c.svg).toContain('UNCOMMITTED CODE ran 1 of 3 matches')
    expect(c.shown + c.hidden).toBe(30)
  })
  it('an empty session says so', () => {
    expect(sessionCard(sessionModel(groupSessions([match(1, []), match(2, [])])[0])).subheading).toBe('No errors or warnings in any match')
  })
})

describe('review fixes', () => {
  it('two matches with one label (a replay) have distinct column and point ids, and the component renders', async () => {
    const s = groupSessions([match(1, [FOLLOW]), { ...match(1, [FOLLOW]), fileName: 'q1-replay.wpilog', playedAt: Date.UTC(2026, 9, 17, 22, 30) }, match(2, [])])[0]
    const m = sessionModel(s, new Map(), { 'q1.wpilog': 'B-1' })
    expect(m.grid.columns.map((c) => c.label).sort()).toEqual(['Qualification 1', 'Qualification 1', 'Qualification 2'])
    expect(new Set(m.grid.columns.map((c) => c.id)).size).toBe(3)
    for (const p of m.trends.panels) expect(new Set(p.points.map((x) => x.id)).size).toBe(p.points.length)
    const { render } = await import('svelte/server')
    const { default: SessionReport } = await import('../src/ui/SessionReport.svelte')
    const html = render(SessionReport, { props: { session: s, issues: new Map(), typedBatteries: {} } }).body
    expect(html).toContain('Hindsight session report')
    expect(html.match(/Qualification 1/g)!.length).toBeGreaterThan(2)
  })
  it('summarizing a match: a rule that crashed is "not checked" with the reason, never quiet', () => {
    const a = analyzeFixture('p0-brownout').analyses[0]
    const report = { ...a.report, findings: a.report.findings.filter((f) => f.rule !== 'loop/overrun'), skipped: a.report.skipped.filter((x) => x.rule !== 'loop/overrun'), crashed: [{ rule: 'loop/overrun', reason: 'Error: boom' }] }
    const r = summarizeMatch(a.match, report, 1).rules['loop/overrun']
    expect(r).toMatchObject({ status: 'not checked', reason: 'crashed: Error: boom' })
  })
  it('the downloaded file, the PDF footer and the CLI name the same file', () => {
    const s = three()
    expect(sessionModel(s).jsonFile).toBe(`${sessionBase(s.label)}.session-findings.json`)
  })
  it('session-findings.json carries each match\'s build (additive, schema stays /1)', () => {
    const j = buildSessionJson(three()) as { schema: string; matches: { build: unknown }[] }
    expect(j.schema).toBe('hindsight.session-findings/1')
    expect(j.matches[0].build).toEqual({ sha: 'abc1234', branch: 'main', uncommitted: false })
    expect(buildSessionJson(groupSessions([match(1, [], { build: undefined })])[0]) as { matches: { build: unknown }[] }).toMatchObject({ matches: [{ build: null }] })
  })
  it('a consistent warning outranks a once-only error on the card, then severity, then match count', () => {
    const c = sessionCard(sessionModel(three()))
    expect(c.items[0]).toMatchObject({ word: 'WARNING · CONSISTENT' })
    expect(c.items[1]).toMatchObject({ word: 'ERROR · ONCE' })
  })
  it('the card leaves out a measured number the title already says', () => {
    const brown = { ...BROWN, title: 'Browned out 53 times' }
    const s = groupSessions([match(1, [{ ...brown }]), match(2, []), match(3, [])])[0]
    ;(s.matches[0].rules['power/brownout'].findings[0] as { measured?: unknown }).measured = [{ label: 'brownouts', value: 53, unit: '', threshold: undefined }]
    expect(sessionCard(sessionModel(s)).items[0].number).toBe('1 of 3 matches')
    ;(s.matches[0].rules['power/brownout'].findings[0] as { measured?: unknown }).measured = [{ label: 'lowest voltage', value: 5.99, unit: 'V', threshold: undefined }]
    expect(sessionCard(sessionModel(s)).items[0].number).toBe('1 of 3 matches · lowest voltage 5.99 V')
  })
  it('folds the once-only findings into one line when there are more than 8; repeated ones keep their rows', () => {
    const once = (i: number): Fire => ({ key: `loop/overrun · ${i}`, rule: i % 2 ? 'loop/overrun' : 'power/brownout', severity: i % 3 ? 'warning' : 'error', title: `Thing ${i}` })
    const many = Array.from({ length: 60 }, (_, i) => once(i))
    const s = groupSessions([match(1, many), match(2, [FOLLOW]), match(3, [FOLLOW])])[0]
    const m = sessionModel(s)
    expect(m.findings.length).toBe(61)
    expect(m.rows.length).toBeLessThanOrEqual(25)
    expect(m.rows.map((r) => r.key)).toEqual([FOLLOW.key])
    expect(m.onceFold).toMatchObject({ count: 60, rules: 2 })
    expect(m.onceFold!.text).toMatch(/^power\/brownout ×30 \(Qualification 1\); loop\/overrun ×30 \(Qualification 1\)$/)
    // 8 or fewer: no fold.
    const few = sessionModel(groupSessions([match(1, many.slice(0, ONCE_FOLD_ABOVE)), match(2, []), match(3, [])])[0])
    expect(few.onceFold).toBeNull()
    expect(few.rows.length).toBe(ONCE_FOLD_ABOVE)
    // The card still lists every finding, not the fold.
    expect(sessionCard(m).items.length).toBe(61)
  })
  it('joining the pieces of a split match: uncommitted if any piece ran uncommitted code', () => {
    const j = joinPieces([match(1, []), match(1, [], { fileName: 'q1b.wpilog', build: { sha: 'abc1234', branch: 'main', uncommitted: true } })])
    expect(j.build).toEqual({ sha: 'abc1234', branch: 'main', uncommitted: true })
    expect(joinPieces([match(1, []), match(1, [], { fileName: 'q1b.wpilog' })]).build!.uncommitted).toBe(false)
  })
  it('a crashed rule counts as not checked, with a note in the report', async () => {
    const crashed = match(1, [], {})
    crashed.rules['loop/overrun'] = { status: 'not checked', reason: 'crashed: boom', findings: [] }
    const s = groupSessions([crashed, match(2, [])])[0]
    expect(crashedNote(s)).toMatch(/^1 rule crashed in 1 match .*loop\/overrun/)
    expect(sessionModel(s).notes.some((n) => /crashed in 1 match/.test(n))).toBe(true)
    expect(gridModel(s).rows.find((r) => r.rule === 'loop/overrun')!.cells).toEqual(['not checked', 'quiet'])
  })
})

describe.skipIf(!haveCalGames)('the three CalGames logs as a session report', () => {
  const session = haveCalGames ? groupSessions([CALGAMES.q13, CALGAMES.q21, CALGAMES.p0].map((p) => summarizeLog(readInput(p))!))[0] : undefined
  it('follower mismatch is "Consistent" 3 of 3 and brownout "Once" 1 of 3, on the report and the card, from one model', () => {
    const m = sessionModel(session!)
    expect(m.findings.find((f) => f.rule === 'mech/follower-mismatch')).toMatchObject({ confidenceWord: 'Consistent', ratio: '3 of 3' })
    expect(m.findings.find((f) => f.rule === 'power/brownout')).toMatchObject({ confidenceWord: 'Once', ratio: '1 of 3' })
    expect(m.findings.map((f) => f.key).sort()).toEqual(mergeFindings(session!).map((f) => f.key).sort())
    expect(m.uncommitted).toBe(1)
    const c = sessionCard(m)
    expect(c.items.length).toBe(m.findings.length)
    expect(c.items.find((i) => i.title.includes('Browned out'))!.word).toBe('ERROR · ONCE')
  })
})
