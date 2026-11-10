// The Trends table's model (src/session/trends.ts): verdicts, worst match, order, what to do. The part on the team's
// 2026 event runs only where its 8 logs are listed (tests/helpers/team-logs.ts; they are never copied into the repo).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { joinSplitMatches } from '../src/session/session.ts'
import { summarizeLog, type MatchMetrics, type MatchSummary } from '../src/session/summary.ts'
import { firstSentence, trendLabel, trendRows, type TrendRow } from '../src/session/trends.ts'
import { haveLogs, LOGS } from './helpers/load.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'

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
    expect(r.verdict).toBe('Under its brownout setting + 1 V in 1 of 3 matches; 1 not judged (no brownout setting)')
    // Every log without a setting: the row has no line at all, and says why.
    const none = row(trendRows([m(1, { minVolts: 5.5, brownoutVolts: null })]), 'minVolts')
    expect(none).toMatchObject({ line: null, pastCount: 0, verdict: 'No line (brownout setting not logged): 5.50 to 5.50 V' })
  })
  it('says how many matches no line judged, and does not call a row clear or the unjudged worst "past the line"', () => {
    const mixed = row(trendRows([m(1, { minVolts: 5.5, brownoutVolts: null }), m(2, { minVolts: 8, brownoutVolts: 6 })]), 'minVolts')
    expect(mixed.verdict).toBe('Under 7 V in 0 of 2 matches; 1 not judged (no brownout setting)')
    expect(mixed.next.text).toMatch(/not judged/)
    expect(mixed.next.source).toBe('none')
    // The lowest voltage, but not judged: not past, and so not the "latest is the worst" call either.
    const latest = row(trendRows([m(1, { minVolts: 5.5, brownoutVolts: 6 }), m(2, { minVolts: 5.0, brownoutVolts: null })]), 'minVolts')
    expect(latest).toMatchObject({ pastCount: 1, latestIsWorst: false, worstIndex: 1 })
    expect(latest.past).toEqual([true, false])
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
    expect(rs.map((r) => r.metric.key)).toEqual(['minVolts', 'visionOutlierPct', 'loopOverrunPct', 'followerSecondsOff', 'resistanceMilliohms', 'secondsUnder7', 'chargeAh', 'belowHealthyVolts'])
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
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: 0, onField: true, fileName: 'akit_q4.wpilog' }), 0)).toBe('On field')
    // A practice log (off the field) with no match type is a numbered log, never "On field".
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: 0, onField: false, fileName: 'akit_q4.wpilog' }), 2)).toBe('#3')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: null, fileName: 'akit_q4.wpilog' }), 2)).toBe('#3')
    expect(trendLabel(m(1, {}, { matchLabel: '', matchType: undefined }), 0)).toBe('#1')
  })
})

const DIR = teamPath(TEAM.event2026)
const have = existsSync(DIR) && haveLogs
if (!have) console.warn('SKIPPED the 2026 event part of trends.test.ts: list its folder (event2026) and logs A, B, C in tests/helpers/team-logs.ts')
describe.skipIf(!have)('trendRows on the 8 logs of the team\'s 2026 event', () => {
  const sums = have
    ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')).map((f) => summarizeLog({ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) })!)
    : []
  sums.sort((a, b) => (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity))
  const matches = joinSplitMatches(sums)
  const rows = trendRows(matches)
  const label = (path: string) => rows[0].labels[matches.findIndex((m) => m.fileName === basename(path))]
  const worst = (k: string) => { const r = row(rows, k); return `${r.labels[r.worstIndex!]} ${r.values[r.worstIndex!]!.toFixed(r.metric.digits)}` }

  it('has 8 matches and the numbers the proposal measured', () => {
    expect(matches).toHaveLength(8)
    expect(row(rows, 'minVolts')).toMatchObject({ pastCount: 8, n: 8, latestIsWorst: true, verdict: 'Under 7 V in 8 of 8 matches' })
    expect(label(LOGS.c)).toMatch(/^Q\d+$/)
    expect(worst('minVolts')).toBe(`${label(LOGS.c)} 5.69`)
    expect(row(rows, 'loopOverrunPct').pastCount).toBe(8)
    expect(worst('loopOverrunPct')).toBe(`${label(LOGS.a)} 26.7`)
    expect(row(rows, 'visionOutlierPct').pastCount).toBe(8)
    expect(worst('visionOutlierPct')).toBe(`${label(teamPath(TEAM.event2026Files?.visionWorst))} 43.5`)
    expect(row(rows, 'resistanceMilliohms').pastCount).toBe(0)
    expect(row(rows, 'followerSecondsOff')).toMatchObject({ pastCount: 7, n: 8 })
  })
  it('plots the follower rule\'s own seconds: equal to its finding\'s number in every match where it fired', () => {
    let fired = 0
    matches.forEach((mt, i) => {
      // A stopped-follower finding counts seconds under 20 % of the leader, not seconds off it at steady speed: Trends
      // doesn't plot it.
      const findings = mt.rules['mech/follower-mismatch'].findings.filter((f) => f.severity !== 'info' && !f.evidence['stopped follower'])
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
  it('adds a current-at-steady-speed row per motor: the rollers\' band holds 8 cells, the dead follower reads low and the dragging pair high', () => {
    const drag = rows.filter((r) => String(r.metric.key).startsWith('drag:'))
    // Four flywheel motors and two rollers, in profile order, after the eight others
    expect(rows.slice(8)).toEqual(drag)
    expect(drag.map((r) => r.metric.key)).toEqual(['drag:Flywheel/Flywheel leader', 'drag:Flywheel/Flywheel follower 16', 'drag:Flywheel/Flywheel follower 17', 'drag:Flywheel/Flywheel follower 18', 'drag:Intake rollers/Intake roller leader', 'drag:Intake rollers/Intake roller follower'])
    const leader = drag[4], follower = drag[5]
    expect(leader.metric.sub).toBe('at 23–28 rot/s')
    expect([leader.n, follower.n]).toEqual([8, 8])
    expect(follower.worstIndex).toBe(7)
    expect(follower.lowestIndex).toBe(5)
    expect(leader.worstIndex).toBe(5)
    expect(leader.lowestIndex).toBe(6)
    // Every row that is shown has 3 or more cells
    expect(drag.every((r) => r.n >= 3)).toBe(true)
  })
  it('draws the line from each log\'s brownout setting: 6.0 V + 1.0 V = 7 V', () => {
    expect(row(rows, 'minVolts').lines).toEqual(Array(8).fill(7))
  })
})

// A motor's current at a steady speed: one row per motor, after the others (src/session/trends.ts dragRows).
describe('trendRows: current at steady speed', () => {
  const band = (b: number, amps: number, seconds = 5) => ({ band: b, lo: 1.25 ** b, hi: 1.25 ** (b + 1), amps, seconds })
  const mo = (motor: string, group: string, bands: ReturnType<typeof band>[]) => ({ motor, group, unit: 'rot/s', bands })
  const withDrag = (n: number, drag: ReturnType<typeof mo>[]) => m(n, {}, { metrics: { ...BLANK, drag } } as never)
  const dragRowsOf = (rows: TrendRow[]) => rows.filter((r) => String(r.metric.key).startsWith('drag:'))

  it('puts one row per motor after the existing rows, leader and follower adjacent, keyed drag:<motor>', () => {
    const ms = [1, 2, 3].map((n) => withDrag(n, [mo('Roller leader', 'Rollers', [band(13, 5 + n)]), mo('Roller follower', 'Rollers', [band(13, 6 + n)]), mo('Other', 'X', [band(5, 2)])]))
    const rows = trendRows(ms)
    expect(rows.slice(0, 8).map((r) => r.metric.key)).not.toContain('drag:Rollers/Roller leader')
    expect(rows.slice(8).map((r) => r.metric.key)).toEqual(['drag:Rollers/Roller leader', 'drag:Rollers/Roller follower', 'drag:X/Other'])
    expect(new Set(rows.map((r) => r.metric.key)).size).toBe(rows.length)
    const r = rows[8]
    expect(r.metric).toMatchObject({ label: 'Roller leader: current at steady speed', unit: 'A', sub: 'at 18–23 rot/s' })
    expect(r.values).toEqual([6, 7, 8])
    expect(r.line).toBeNull()
    expect(r.pastCount).toBe(0)
  })
  it('compares the band present in the most matches, ties to the band with the most seconds', () => {
    const a = (bands: ReturnType<typeof band>[]) => [mo('M', 'G', bands)]
    // band 13 in 3 matches, band 14 in 2: band 13
    let rows = dragRowsOf(trendRows([withDrag(1, a([band(13, 5), band(14, 8)])), withDrag(2, a([band(13, 6), band(14, 9)])), withDrag(3, a([band(13, 7)])), withDrag(4, a([]))]))
    expect(rows[0].values).toEqual([5, 6, 7, null])
    // 3 matches each: the band with more seconds wins
    rows = dragRowsOf(trendRows([1, 2, 3, 4, 5, 6].map((n) => withDrag(n, a(n <= 3 ? [band(13, n, 4)] : [band(14, 20 + n, 9)])))))
    expect(rows[0].values).toEqual([null, null, null, 24, 25, 26])
    expect(rows[0].metric.sub).toBe('at 23–28 rot/s')
  })
  it('marks both the highest and the lowest cell, and computes worst, latest and the verdict range over filled cells only', () => {
    const a = (amps: number | null) => [mo('F', 'G', amps === null ? [] : [band(13, amps)])]
    const ms = [withDrag(1, a(5.9)), withDrag(2, a(1.0)), withDrag(3, a(null)), withDrag(4, a(9.1)), withDrag(5, a(6.5)), withDrag(6, a(null))]
    const r = dragRowsOf(trendRows(ms))[0]
    expect(r.values).toEqual([5.9, 1.0, null, 9.1, 6.5, null])
    expect(r.worstIndex).toBe(3)
    expect(r.worstWord).toBe('highest')
    expect(r.lowestIndex).toBe(1)
    expect(r.latest).toBeNull() // the last match has no steady run in the band
    expect(r.n).toBe(4)
    expect(r.verdict).toBe('No line: 1.0 to 9.1 A in 4 of 6 matches')
  })
  it('keeps two same-named motors in different groups as separate rows', () => {
    const ms = [1, 2, 3].map((n) => withDrag(n, [mo('M', 'G1', [band(13, n)]), mo('M', 'G2', [band(13, 10 + n)])]))
    const rows = dragRowsOf(trendRows(ms))
    expect(rows.map((r) => r.metric.key)).toEqual(['drag:G1/M', 'drag:G2/M'])
    expect(rows.map((r) => r.values)).toEqual([[1, 2, 3], [11, 12, 13]])
  })
  it('skips a summary whose drag is not an array (a malformed event line), without throwing', () => {
    const a = (amps: number) => [mo('M', 'G', [band(13, amps)])]
    const ms = [withDrag(1, a(5)), withDrag(2, a(6)), withDrag(3, a(7)), withDrag(4, null as never), withDrag(5, { motor: 'M' } as never)]
    const rows = dragRowsOf(trendRows(ms))
    expect(rows).toHaveLength(1)
    expect(rows[0].values).toEqual([5, 6, 7, null, null])
  })
  it('says "the log\'s own speed unit" in the band line when the motor\'s unit is unknown, and "no steady run" for an empty latest cell in Trends.svelte', async () => {
    const noUnit = (amps: number | null) => [{ motor: 'M', group: 'G', bands: amps === null ? [] : [band(16, amps)] }]
    const ms = [5, 6, 7, null].map((v) => withDrag(1, noUnit(v) as never))
    ms.forEach((x, i) => { (x as { fileName: string }).fileName = `q${i + 1}.wpilog` })
    const r = dragRowsOf(trendRows(ms))[0]
    expect(r.metric.sub).toBe("at 36–44 (the log's own speed unit)")
    const { render } = await import('svelte/server')
    const { default: Trends } = await import('../src/ui/Trends.svelte')
    const html = render(Trends, { props: { matches: ms, typedBatteries: {} } }).body
    expect(html).toContain('no steady run')
    expect(html).not.toContain('not logged')
  })
  it('shows a motor only with 3 or more filled cells', () => {
    const a = (amps: number) => [mo('M', 'G', [band(13, amps)])]
    expect(dragRowsOf(trendRows([withDrag(1, a(5)), withDrag(2, a(6))]))).toHaveLength(0)
    expect(dragRowsOf(trendRows([withDrag(1, a(5)), withDrag(2, a(6)), withDrag(3, a(7))]))).toHaveLength(1)
    // 3 matches that have the motor, but never the same band: no band reaches 3
    expect(dragRowsOf(trendRows([withDrag(1, [mo('M', 'G', [band(12, 5)])]), withDrag(2, [mo('M', 'G', [band(13, 5)])]), withDrag(3, [mo('M', 'G', [band(14, 5)])])]))).toHaveLength(0)
  })
  it('renders the rows in Trends.svelte: the band under the label, and the lowest cell beside the highest', async () => {
    const a = (amps: number) => [mo('F', 'G', [band(13, amps)])]
    const ms = [withDrag(1, a(5.9)), withDrag(2, a(1.0)), withDrag(3, a(9.1)), withDrag(4, a(6.5))]
    const { render } = await import('svelte/server')
    const { default: Trends } = await import('../src/ui/Trends.svelte')
    const html = render(Trends, { props: { matches: ms, typedBatteries: {} } }).body
    expect(html).toContain('F: current at steady speed')
    expect(html).toContain('at 18–23 rot/s')
    expect(html).toContain('highest: ')
    expect(html).toMatch(/lowest: [\s\S]*Q2[\s\S]*1\.0 A/)
    expect(html).toMatch(/Q3[\s\S]*9\.1 A/)
  })
  it('has no drag rows for matches saved without drag', () => {
    expect(dragRowsOf(trendRows([m(1, {}), m(2, {}), m(3, {})]))).toHaveLength(0)
  })
})
