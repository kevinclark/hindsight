// The Trends table's model (src/session/trends.ts): verdicts, worst match, order, what to do. The CalGames part runs
// only where the 8 logs are in ~/Downloads/Calgames 2026 (they are never copied into the repo).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { joinSplitMatches } from '../src/session/session.ts'
import { summarizeLog, type MatchMetrics, type MatchSummary } from '../src/session/summary.ts'
import { firstSentence, trendLabel, trendRows, type TrendRow } from '../src/session/trends.ts'

const BLANK: MatchMetrics = { minVolts: null, secondsUnder7: null, chargeAh: null, resistanceMilliohms: null, followerSecondsOff: null, brownoutVolts: 6, loopOverrunPct: null, visionOutlierPct: null }
const m = (n: number, metrics: Partial<MatchMetrics>, over: Partial<MatchSummary> = {}): MatchSummary => ({
  fileName: `q${n}.wpilog`, matchLabel: `Qualification ${n}`, matchType: 2, rules: {}, metrics: { ...BLANK, ...metrics }, ...over,
} as unknown as MatchSummary)
const row = (rows: TrendRow[], key: string) => rows.find((r) => r.metric.key === key)!

describe('trendRows verdicts', () => {
  const volts = [5.7, 6.8, 6.3, 5.9, 6.1, 6.9, 6.0, 5.69]
  const rows = trendRows(volts.map((v, i) => m(i + 1, { minVolts: v })))
  it('says the bad side, the line and "n of N matches"', () => {
    expect(row(rows, 'minVolts').verdict).toBe('Under 7 V in 8 of 8 matches')
    const loops = trendRows([m(1, { loopOverrunPct: 12 }), m(2, { loopOverrunPct: 15 })])
    expect(row(loops, 'loopOverrunPct').verdict).toBe('Over 10 % in 2 of 2 matches')
  })
  it('names the worst match: the lowest for a "below" row, the highest for an "above" row', () => {
    const r = row(rows, 'minVolts')
    expect(r.labels[r.worstIndex!]).toBe('Q8')
    expect(r.values[r.worstIndex!]).toBe(5.69)
    const loops = row(trendRows([m(1, { loopOverrunPct: 12 }), m(2, { loopOverrunPct: 30 }), m(3, { loopOverrunPct: 15 })]), 'loopOverrunPct')
    expect(loops.worstIndex).toBe(1)
  })
  it('says "latest is the worst" only when the last match is strictly the worst and something is past the line', () => {
    expect(row(rows, 'minVolts')).toMatchObject({ latestIsWorst: true, verdict2: 'Latest is the worst (Q8)' })
    const notLast = row(trendRows([m(1, { loopOverrunPct: 30 }), m(2, { loopOverrunPct: 15 })]), 'loopOverrunPct')
    expect(notLast).toMatchObject({ latestIsWorst: false, verdict2: '' })
    const tie = row(trendRows([m(1, { loopOverrunPct: 30 }), m(2, { loopOverrunPct: 30 })]), 'loopOverrunPct')
    expect(tie.latestIsWorst).toBe(false)
    // Within the line in every match: nothing is wrong, so no "worst" claim.
    const fine = row(trendRows([m(1, { resistanceMilliohms: 10 }), m(2, { resistanceMilliohms: 12 })]), 'resistanceMilliohms')
    expect(fine).toMatchObject({ latestIsWorst: false, verdict: 'Over 20 mΩ in 0 of 2 matches' })
  })
  it('gives a match with no brownout setting no voltage line, and does not count it past', () => {
    const rs = trendRows([m(1, { minVolts: 5.5, brownoutVolts: null }), m(2, { minVolts: 5.5, brownoutVolts: 4.5 }), m(3, { minVolts: 5.6, brownoutVolts: 6 })])
    const r = row(rs, 'minVolts')
    expect(r.lines).toEqual([null, 5.5, 7])
    expect(r.past).toEqual([false, false, true])
    expect(r.pastCount).toBe(1)
    expect(r.verdict).toBe('Under its brownout setting + 1 V in 1 of 3 matches')
    // Every log without a setting: the row has no line at all, and says why.
    const none = row(trendRows([m(1, { minVolts: 5.5, brownoutVolts: null })]), 'minVolts')
    expect(none).toMatchObject({ line: null, pastCount: 0, verdict: 'No line (brownout setting not logged): 5.50 to 5.50 V' })
  })
  it('makes no trend call', () => {
    for (const r of rows) expect(`${r.verdict} ${r.verdict2}`).not.toMatch(/worse|better|trend|improv/i)
  })
  it('counts only measured matches and says how many were not logged', () => {
    const r = row(trendRows([m(1, { loopOverrunPct: 12 }), m(2, {}), m(3, { loopOverrunPct: 4 }), m(4, {})]), 'loopOverrunPct')
    expect(r).toMatchObject({ n: 2, total: 4, pastCount: 1, verdict: 'Over 10 % in 1 of 2 measured (2 not logged)' })
    expect(r.values).toEqual([12, null, 4, null])
  })
  it('keeps "not in these logs" for a number no log carries, and sorts it last', () => {
    const rs = trendRows([m(1, { minVolts: 5.5 }), m(2, { minVolts: 6.1 })])
    expect(row(rs, 'visionOutlierPct').verdict).toBe('not in these logs')
    expect(rs.at(-1)!.n).toBe(0)
  })
  it('gives a row without a line the range, "highest", and "No rule for this number"', () => {
    const r = row(trendRows([m(1, { secondsUnder7: 0.2 }), m(2, { secondsUnder7: 12.3 }), m(3, { secondsUnder7: 1.9 })]), 'secondsUnder7')
    expect(r).toMatchObject({ verdict: 'No line: 0.2 to 12.3 s', worstWord: 'highest', worstIndex: 1, pastCount: 0 })
    expect(r.next).toMatchObject({ source: 'no-rule', text: 'No rule for this number' })
  })
  it('judges each match against its own brownout setting + 1 V', () => {
    const r = row(trendRows([m(1, { minVolts: 7.2, brownoutVolts: 6 }), m(2, { minVolts: 7.2, brownoutVolts: 6.5 })]), 'minVolts')
    expect(r.lines).toEqual([7, 7.5])
    expect(r.past).toEqual([false, true])
    expect(r.verdict).toBe('Under its brownout setting + 1 V in 1 of 2 matches')
  })
  it('counts the follower rule\'s "1 s or more" as past, and says nothing for a value below it', () => {
    const r = row(trendRows([m(1, { followerSecondsOff: 1 }), m(2, { followerSecondsOff: 0.9 })]), 'followerSecondsOff')
    expect(r.past).toEqual([true, false])
  })
})

describe('trendRows order', () => {
  it('puts rows past the line first, lowest voltage leading, then by how far past, then within the line, then no-line rows, then absent ones', () => {
    const rs = trendRows([
      m(1, { minVolts: 6.5, secondsUnder7: 3, chargeAh: 5, resistanceMilliohms: 11, followerSecondsOff: 2.5, loopOverrunPct: 26.7, visionOutlierPct: 43.5 }),
      m(2, { minVolts: 5.69, secondsUnder7: 12, chargeAh: 6, resistanceMilliohms: 10, followerSecondsOff: 1.2, loopOverrunPct: 12, visionOutlierPct: 8 }),
    ])
    expect(rs.map((r) => r.metric.key)).toEqual(['minVolts', 'visionOutlierPct', 'loopOverrunPct', 'followerSecondsOff', 'resistanceMilliohms', 'secondsUnder7', 'chargeAh'])
    expect(row(rs, 'visionOutlierPct').pastRatio).toBeCloseTo(8.7)
    expect(row(rs, 'minVolts').pastRatio).toBeCloseTo(7 / 5.69)
  })
  it('puts lowest voltage with the rows within the line when no match is under it', () => {
    const rs = trendRows([m(1, { minVolts: 7.5, visionOutlierPct: 8, resistanceMilliohms: 11 })])
    expect(rs.map((r) => r.metric.key).slice(0, 3)).toEqual(['visionOutlierPct', 'minVolts', 'resistanceMilliohms'])
  })
})

describe('trendRows what to do', () => {
  it('quotes the first sentence of the rule\'s next step with the rule id', () => {
    const r = row(trendRows([m(1, { followerSecondsOff: 2 })]), 'followerSecondsOff')
    expect(r.next).toEqual({ text: 'Check belt tension, pulleys and set screws on the slow motor.', source: 'rule', ruleId: 'mech/follower-mismatch' })
    expect(firstSentence('Keep 1.0 V of margin: do it. Then more.')).toBe('Keep 1.0 V of margin: do it.')
  })
  it('quotes the worst match\'s own next step instead when its finding has one', () => {
    const own = { rules: { 'vision/outliers': { status: 'fired', findings: [{ key: 'vision/outliers · Cam', severity: 'warning', nextStep: 'Zero the odometry off the field. Then re-run.' }] } } }
    const r = row(trendRows([m(1, { visionOutlierPct: 9 }), m(2, { visionOutlierPct: 40 }, own as never)]), 'visionOutlierPct')
    expect(r.next).toEqual({ text: 'Zero the odometry off the field.', source: 'match', ruleId: 'vision/outliers' })
    // The same finding on a match that is not the worst does not override.
    const other = row(trendRows([m(1, { visionOutlierPct: 9 }, own as never), m(2, { visionOutlierPct: 40 })]), 'visionOutlierPct')
    expect(other.next.source).toBe('rule')
  })
  it('says "Nothing: within the line" for a row within the line in every match', () => {
    const r = row(trendRows([m(1, { resistanceMilliohms: 11 })]), 'resistanceMilliohms')
    expect(r.next).toMatchObject({ source: 'within', text: 'Nothing: within the line' })
  })
})

describe('trend labels', () => {
  it('keeps a labelled match\'s short label, labels an unnumbered log from its MatchType, and never from its file name', () => {
    expect(trendLabel(m(13, {}), 0)).toBe('Q13')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: 1 }), 0)).toBe('Pr')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: 0, fileName: 'akit_q13.wpilog' }), 0)).toBe('On field')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: null, fileName: 'akit_q13.wpilog' }), 2)).toBe('#3')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: undefined }), 0)).toBe('#1')
  })
})

const DIR = `${homedir()}/Downloads/Calgames 2026`
const have = existsSync(DIR)
if (!have) console.warn('SKIPPED the CalGames part of trends.test.ts: put the 8 CalGames .wpilog files in ~/Downloads/Calgames 2026')
describe.skipIf(!have)('trendRows on the 8 CalGames logs', () => {
  const sums = have
    ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')).map((f) => summarizeLog({ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) })!)
    : []
  sums.sort((a, b) => (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity))
  const matches = joinSplitMatches(sums)
  const rows = trendRows(matches)
  const worst = (k: string) => { const r = row(rows, k); return `${r.labels[r.worstIndex!]} ${r.values[r.worstIndex!]!.toFixed(r.metric.digits)}` }

  it('has 8 matches and the numbers the proposal measured', () => {
    expect(matches).toHaveLength(8)
    expect(row(rows, 'minVolts')).toMatchObject({ pastCount: 8, n: 8, latestIsWorst: true, verdict: 'Under 7 V in 8 of 8 matches' })
    expect(worst('minVolts')).toBe('Q42 5.69')
    expect(row(rows, 'loopOverrunPct').pastCount).toBe(8)
    expect(worst('loopOverrunPct')).toBe('Q13 26.7')
    expect(row(rows, 'visionOutlierPct').pastCount).toBe(8)
    expect(worst('visionOutlierPct')).toBe('Q2 43.5')
    expect(row(rows, 'resistanceMilliohms').pastCount).toBe(0)
    expect(row(rows, 'followerSecondsOff')).toMatchObject({ pastCount: 7, n: 8 })
  })
  it('plots the follower rule\'s own seconds: equal to its finding\'s number in every match where it fired', () => {
    let fired = 0
    matches.forEach((mt, i) => {
      const findings = mt.rules['mech/follower-mismatch'].findings.filter((f) => f.severity !== 'info')
      if (!findings.length) return
      fired++
      const evidence = Math.max(...findings.map((f) => f.measured![0].value))
      expect(+row(rows, 'followerSecondsOff').values[i]!.toFixed(1), mt.fileName).toBe(evidence)
    })
    expect(fired).toBe(7)
    // And a match where the rule did not fire is below its 1 s line.
    matches.forEach((mt, i) => {
      if (mt.rules['mech/follower-mismatch'].status !== 'fired') expect(row(rows, 'followerSecondsOff').values[i]!).toBeLessThan(1)
    })
  })
  it('draws the line from each log\'s brownout setting: 6.0 V + 1.0 V = 7 V', () => {
    expect(row(rows, 'minVolts').lines).toEqual(Array(8).fill(7))
  })
})
