// Sags as stretches (src/power/sag-spans.ts): runs of samples under the margin line, with the robot's state as each
// began and the biggest motor groups at the lowest point, during it and in the half second before. The first part is a
// synthetic log whose cached grid the tests then change; the second reads the team's 2026 event logs
// (tests/helpers/team-logs.ts) by their place in the sorted list, never by name.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { buildPowerGrid, DT, type PowerGrid } from '../src/power/battery-model.ts'
import { powerReport } from '../src/power/power-report.ts'
import { buildSagSpans, sagSpansUncapped, LOOK_BEFORE_S, MERGE_GAP_S, MIN_SPAN_S, SPAN_CAP } from '../src/power/sag-spans.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'
import { haveLogs } from './helpers/load.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const STATE_KEY = '/RealOutputs/Superstructure/State'

type Opts = { brownout?: number; state?: [number, string][]; profile?: RobotProfile }

/** A 40 s log: battery 12 V, enabled 2-12 s (grid samples 100-599), brownout setting `brownout` V when given. */
function analysisOf(o: Opts = {}) {
  const t = Array.from({ length: 41 }, (_, i) => i)
  const series = (name: string, v: (i: number) => number | boolean, type = 'double'): FixtureEntry => ({ name, type, records: t.map((i) => [i, v(i)]) })
  const entries: FixtureEntry[] = [
    series('/DriverStation/Enabled', (i) => i >= 2 && i < 12, 'boolean'),
    series('/SystemStats/BatteryVoltage', () => 12),
    series('/Intake/Roller Leader/SupplyCurrentAmps', () => 3),
    series('/Intake/Roller Leader/Connected', () => true, 'boolean'),
    series('/Drum/Flywheel/Leader/SupplyCurrentAmps', () => 10),
    series('/Drum/Flywheel/Leader/Connected', () => true, 'boolean'),
  ]
  if (o.brownout !== undefined) entries.push(series('/SystemStats/BrownoutVoltage', () => o.brownout!))
  if (o.state) entries.push({ name: STATE_KEY, type: 'string', records: o.state })
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], o.profile ?? offseason2026).analyses[0]
}
/** A match with a 6.0 V brownout setting (so the line is 7.0 V), a quiet grid, and no current in any group. */
function quiet(o: Opts = {}) {
  const match = analysisOf({ brownout: 6, ...o }).match
  const g = buildPowerGrid(match)!
  for (const x of g.groups) x.amps.fill(0)
  return { match, g }
}
/** The analysis has already computed powerReport on the unchanged grid: drop it so it reads the changed one. */
const redo = (m: { cache: Map<string, unknown> }) => m.cache.delete('power:report')
const dip = (g: PowerGrid, from: number, n: number, v = 6.5) => g.volts.fill(v, from, from + n)
const group = (g: PowerGrid, name: string) => g.groups.find((x) => x.name === name)!.amps
const noState = (): RobotProfile => {
  const { robotState: _, ...signals } = offseason2026.signals
  return { ...offseason2026, signals }
}

describe('the constants are NOMAD 6995\'s defaults (ideas only), assumed', () => {
  it('floor 0.04 s, merge gap 0.25 s, look back 0.5 s, 8 kept', () => {
    expect([MIN_SPAN_S, MERGE_GAP_S, LOOK_BEFORE_S, SPAN_CAP]).toEqual([0.04, 0.25, 0.5, 8])
  })
})

describe('buildSagSpans: finding the stretches', () => {
  it('puts the line at the brownout setting plus the profile margin: 6 V + 1 V = 7 V', () => {
    const { match, g } = quiet()
    dip(g, 300, 5)
    expect(buildSagSpans(match)!.line).toBe(7)
    expect(offseason2026.power.marginVolts).toBe(1)
  })
  it('drops a run under 0.04 s: 1 sample is dropped, 2 are kept', () => {
    const { match, g } = quiet()
    dip(g, 200, 1); dip(g, 300, 2); dip(g, 400, 10)
    const r = buildSagSpans(match)!
    expect(r.mode).toBe('stretches')
    expect(r.totalSpans).toBe(2)
    expect(r.spans.map((s) => s.start).sort()).toEqual([g.t[300], g.t[400]])
    expect(r.spans.find((s) => s.start === g.t[300])!.seconds).toBeCloseTo(0.04, 9)
    expect(r.spans.find((s) => s.start === g.t[400])!.seconds).toBeCloseTo(0.2, 9)
  })
  it('counts a sample at exactly the line as not under it', () => {
    const { match, g } = quiet()
    dip(g, 300, 10, 7.0); dip(g, 400, 4)
    expect(buildSagSpans(match)!.totalSpans).toBe(1)
  })
  it('merges runs 0.24 s apart into one span, and keeps runs 0.26 s apart as two', () => {
    const a = quiet()
    dip(a.g, 200, 3); dip(a.g, 200 + 3 + 12, 3) // gap 12 samples = 0.24 s
    const one = buildSagSpans(a.match)!
    expect(one.totalSpans).toBe(1)
    expect(one.spans[0].start).toBe(a.g.t[200])
    expect(one.spans[0].end).toBeCloseTo(a.g.t[218], 9)
    expect(one.spans[0].seconds).toBeCloseTo(0.36, 9) // the stretch, from its first sample to its last
    const b = quiet()
    dip(b.g, 200, 3); dip(b.g, 200 + 3 + 13, 3) // gap 13 samples = 0.26 s
    expect(buildSagSpans(b.match)!.totalSpans).toBe(2)
  })
  it('drops short runs before it merges: a 1-sample blip does not bridge two runs 0.30 s apart', () => {
    const { match, g } = quiet()
    dip(g, 200, 3); dip(g, 210, 1); dip(g, 218, 3)
    const r = buildSagSpans(match)!
    expect(r.totalSpans).toBe(2)
    expect(r.spans.map((s) => s.start).sort()).toEqual([g.t[200], g.t[218]])
  })
  it('breaks a span at disabled samples, and ignores a sag while disabled', () => {
    const { match, g } = quiet()
    dip(g, 300, 40)
    g.enabled.fill(0, 315, 335) // 0.4 s disabled in the middle
    dip(g, 50, 20) // before the match is enabled (sample 100)
    const r = buildSagSpans(match)!
    expect(r.totalSpans).toBe(2)
    expect(r.spans.map((s) => s.start).sort()).toEqual([g.t[300], g.t[335]])
  })
  it('skips samples whose voltage is NaN or 0', () => {
    const { match, g } = quiet()
    dip(g, 300, 10, NaN); dip(g, 400, 10, 0); dip(g, 500, 4)
    const r = buildSagSpans(match)!
    expect(r.totalSpans).toBe(1)
    expect(r.spans[0].start).toBe(g.t[500])
  })
  it('reports the lowest voltage and when, and the stretch\'s end as just past its last sample', () => {
    const { match, g } = quiet()
    dip(g, 300, 10, 6.8); g.volts[304] = 6.1
    const s = buildSagSpans(match)!.spans[0]
    expect(s).toMatchObject({ lowestVolts: 6.1, lowestAt: g.t[304], start: g.t[300] })
    expect(s.end).toBeCloseTo(g.t[309] + DT, 9)
    expect(s.seconds).toBeCloseTo(0.2, 9)
  })
})

describe('buildSagSpans: what was drawing', () => {
  it('ranks the groups three ways, and the three can disagree: before, at the lowest point, and during', () => {
    const { match, g } = quiet()
    dip(g, 400, 10, 6.8); g.volts[405] = 6.0
    const drive = group(g, 'Drive'); const fly = group(g, 'Flywheel'); const roll = group(g, 'Intake rollers'); const steer = group(g, 'Steer')
    drive.fill(100, 375, 400) // the 0.5 s before: 25 samples
    drive.fill(20, 400, 410)
    fly.fill(30, 400, 410); fly[405] = 60
    roll.fill(40, 400, 410); roll[405] = 0
    steer.fill(2, 400, 410)
    group(g, 'Hood').fill(0.5, 400, 410) // under 1 A: never listed
    const s = buildSagSpans(match)!.spans[0]
    expect(s.atLowest).toEqual([{ group: 'Flywheel', amps: 60 }, { group: 'Drive', amps: 20 }, { group: 'Steer', amps: 2 }])
    expect(s.during!.map((x) => x.group)).toEqual(['Intake rollers', 'Flywheel', 'Drive']) // top 3 of 4 groups above 1 A
    expect(s.during![0].amps).toBeCloseTo(36, 9)
    expect(s.during![1].amps).toBeCloseTo(33, 9)
    expect(s.before).toEqual([{ group: 'Drive', amps: 100 }])
    expect(s.atLowest[0].group).not.toBe(s.before[0].group)
    expect(s.before[0].group).not.toBe(s.during![0].group)
  })
  it('averages the 0.5 s before over exactly 25 samples, not 24 or 26', () => {
    const { match, g } = quiet()
    dip(g, 300, 5)
    const drive = group(g, 'Drive')
    drive[274] = 999; drive.fill(40, 275, 300); drive[300] = 5
    expect(buildSagSpans(match)!.spans[0].before).toEqual([{ group: 'Drive', amps: 40 }])
  })
  it('clips the 0.5 s window at the start of the grid', () => {
    const { match, g } = quiet()
    dip(g, 10, 5); g.enabled.fill(1, 0, 20) // enabled from the first sample
    group(g, 'Drive').fill(50, 0, 10)
    group(g, 'Flywheel').fill(8, 0, 5) // half the 10 samples before
    const s = buildSagSpans(match)!
    expect(s.spans[0].before).toEqual([{ group: 'Drive', amps: 50 }, { group: 'Flywheel', amps: 4 }])
  })
})

describe('buildSagSpans: order, cap, counts and state', () => {
  it('sorts deepest first, keeps 8, and counts every span and its seconds before the cap', () => {
    const { match, g } = quiet()
    for (let k = 0; k < 10; k++) dip(g, 150 + 40 * k, 5, 6 + 0.05 * ((k * 3) % 10))
    const r = buildSagSpans(match)!
    expect(r.spans).toHaveLength(8)
    expect(r.totalSpans).toBe(10)
    expect(r.secondsUnderLine).toBeCloseTo(10 * 5 * DT, 9)
    const lows = r.spans.map((s) => s.lowestVolts)
    expect(lows).toEqual([...lows].sort((a, b) => a - b))
    expect(lows[0]).toBeCloseTo(6.0, 9)
    expect(lows[7]).toBeCloseTo(6.35, 9) // the two shallowest, 6.4 and 6.45, are cut
    expect(sagSpansUncapped(match)!.spans).toHaveLength(10)
  })
  it('gives the state at the span\'s start, holding the last value; null before the first value', () => {
    const { match, g } = quiet({ state: [[3, 'A'], [6, 'B'], [9, 'C']] })
    dip(g, 120, 5) // 2.4 s: before the first value
    dip(g, 350, 5) // 7.0 s: B
    dip(g, 450, 5) // 9.0 s: C, from exactly its record
    const by = new Map(buildSagSpans(match)!.spans.map((s) => [s.start, s.stateAtStart]))
    expect(by.get(g.t[120])).toBeNull()
    expect(by.get(g.t[350])).toBe('B')
    expect(by.get(g.t[450])).toBe('C')
  })
  it('has no state when the profile names no state signal, or the log lacks it', () => {
    const a = quiet({ profile: noState(), state: [[0, 'A']] })
    dip(a.g, 300, 5)
    expect(buildSagSpans(a.match)!.spans[0].stateAtStart).toBeNull()
    const b = quiet()
    dip(b.g, 300, 5)
    expect(buildSagSpans(b.match)!.spans[0].stateAtStart).toBeNull()
  })
  it('is cached under power:sag-spans, and null when there is no power grid', () => {
    const { match, g } = quiet()
    dip(g, 300, 5)
    const r = buildSagSpans(match)
    expect(buildSagSpans(match)).toBe(r)
    expect(match.cache.has('power:sag-spans')).toBe(true)
    const noVolts = analyzeFiles([{ name: 'x.wpilog', bytes: writeWpilog([{ name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [1, true]] }]) }], offseason2026).analyses[0].match
    expect(buildSagSpans(noVolts)).toBeNull()
  })
})

describe('buildSagSpans: the two fallbacks to the lowest points', () => {
  it('with no brownout setting: today\'s sag points, no length, nothing "during", and it says why', () => {
    const match = analysisOf().match
    const g = buildPowerGrid(match)!
    dip(g, 300, 5, 5.0); dip(g, 500, 5, 6.0)
    group(g, 'Drive').fill(70, 275, 300)
    redo(match)
    const r = buildSagSpans(match)!
    const sags = powerReport(match)!.sags
    expect(r.mode).toBe('lowest-points')
    expect(Number.isNaN(r.line)).toBe(true)
    expect(r.reason).toMatch(/brownout setting/i)
    expect(r.spans).toHaveLength(sags.length)
    expect(r.spans.map((s) => s.lowestAt)).toEqual(sags.map((s) => s.t))
    expect(r.spans[0]).toMatchObject({ seconds: 0, during: null, lowestVolts: 5, lowestAt: g.t[300], start: g.t[300] })
    expect(r.spans[0].atLowest).toEqual(sags[0].loads.map((l) => ({ group: l.group, amps: l.amps })).slice(0, 3))
    expect(r.spans[0].before[0]).toEqual({ group: 'Drive', amps: 70 })
    expect(r.totalSpans).toBe(0)
  })
  it('when the match never goes under the line: the same points, and it says so', () => {
    const { match, g } = quiet()
    g.volts.fill(9, 0, 500); dip(g, 300, 5, 7.4)
    redo(match)
    const r = buildSagSpans(match)!
    expect(r.line).toBe(7)
    expect(r.mode).toBe('lowest-points')
    expect(r.reason).toMatch(/never/i)
    expect(r.spans[0]).toMatchObject({ lowestVolts: 7.4, seconds: 0, during: null })
    expect(r.spans[0].lowestAt).toBe(powerReport(match)!.sags[0].t)
  })
  it('a fallback point gets the state at that time', () => {
    const match = analysisOf({ state: [[0, 'A'], [5, 'B']] }).match
    const g = buildPowerGrid(match)!
    dip(g, 400, 5, 5.0) // 8.0 s
    redo(match)
    expect(buildSagSpans(match)!.spans[0].stateAtStart).toBe('B')
  })
})

describe('the Power tab and the plot', () => {
  it('shows the heading, the sentence when capped, the columns, and shaded spans on the voltage plot', async () => {
    const analysis = analysisOf({ brownout: 6 })
    const g = buildPowerGrid(analysis.match)!
    for (let k = 0; k < 10; k++) dip(g, 150 + 40 * k, 5, 6 + 0.05 * ((k * 3) % 10))
    const { render } = await import('svelte/server')
    const { default: PowerTab } = await import('../src/ui/PowerTab.svelte')
    const html = render(PowerTab, { props: { analysis } }).body
    expect(html).toContain('The 8 deepest sags under 7 V, and what was drawing')
    expect(html).toContain('10 stretches under 7 V, 1.0 s in all; the 8 deepest:')
    for (const col of ['When', 'Length', 'Lowest', 'State', 'At lowest', 'During', 'Before']) expect(html).toMatch(new RegExp(`<th[^>]*>${col}</th>`))
    expect(html).toMatch(/<rect[^>]*class="span/)
  })
  it('in fallback mode keeps the old heading and says why, with markers and no shaded spans', async () => {
    const analysis = analysisOf()
    const g = buildPowerGrid(analysis.match)!
    dip(g, 300, 5, 5.0)
    redo(analysis.match)
    const { render } = await import('svelte/server')
    const { default: PowerTab } = await import('../src/ui/PowerTab.svelte')
    const html = render(PowerTab, { props: { analysis } }).body
    expect(html).toMatch(/The \d+ deepest sags, and what was drawing/)
    expect(html).toMatch(/no brownout setting/i)
    expect(html).not.toMatch(/<rect[^>]*class="span/)
    expect(html).toContain('class="marker')
  })
  it('Plot draws each { from, to } of model.spans as a rectangle behind the lines', async () => {
    const { render } = await import('svelte/server')
    const { default: Plot } = await import('../src/ui/Plot.svelte')
    const model = { from: 0, to: 10, unit: 'V', series: [{ label: 'v', t: [0, 5], v: [12, 6] }], spans: [{ from: 2, to: 3 }, { from: 6, to: 7 }] }
    const html = render(Plot, { props: { model } }).body
    expect(html.match(/<rect[^>]*class="span/g)).toHaveLength(2)
    expect(html.indexOf('class="span')).toBeLessThan(html.indexOf('<path'))
  })
  it('the findings export carries power.sagSpans beside the unchanged power.sags', () => {
    const analysis = analysisOf({ brownout: 6 })
    const g = buildPowerGrid(analysis.match)!
    dip(g, 300, 10); dip(g, 400, 10, 6.2)
    const power = (buildFindingsJson(analysis.match, analysis.report) as { power: { sags: unknown[]; sagSpans: { line: number; mode: string; totalSpans: number; secondsUnderLine: number; spans: { seconds: number }[] } } }).power
    expect(power.sags.length).toBeGreaterThan(0)
    expect(power.sagSpans).toMatchObject({ line: 7, mode: 'stretches', totalSpans: 2 })
    expect(power.sagSpans.spans).toHaveLength(2)
  })
})

// ---- the team's 2026 event logs ----
const DIR = teamPath(TEAM.event2026)
const have = existsSync(DIR) && haveLogs
if (!have) console.warn('SKIPPED the 2026 event part of sag-spans.test.ts: list its folder (event2026) in tests/helpers/team-logs.ts')

describe.skipIf(!have)('sag stretches in the 8 logs of the team\'s 2026 event, against the evidence note', () => {
  const files = have ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')) : []
  const rows = files.map((f) => {
    const m = analyzeFiles([{ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) }]).analyses[0].match
    const all = sagSpansUncapped(m)
    const shown = buildSagSpans(m)
    const top = (l: { group: string }[] | null | undefined) => l?.[0]?.group ?? null
    const spans = all?.spans ?? []
    return {
      line: all?.line, total: spans.length, shown: shown?.spans.length ?? 0, mode: shown?.mode,
      beforeNeLowest: spans.filter((s) => top(s.before) !== top(s.atLowest)).length,
      beforeNeDuring: spans.filter((s) => top(s.before) !== top(s.during)).length,
    }
  })
  const sum = (k: 'total' | 'shown' | 'beforeNeLowest' | 'beforeNeDuring') => rows.reduce((s, r) => s + r[k], 0)
  it('has the 8 logs and prints the per-log counts', () => {
    expect(files).toHaveLength(8)
    console.log(['log | line | spans before cap | shown | top group before != at lowest | before != during',
      ...rows.map((r, i) => `${i} | ${r.line} | ${r.total} | ${r.shown} | ${r.beforeNeLowest} | ${r.beforeNeDuring}`),
      `all | | ${sum('total')} | ${sum('shown')} | ${sum('beforeNeLowest')} | ${sum('beforeNeDuring')}`].join('\n'))
  })
  it('uses the 7.0 V line in every log', () => rows.forEach((r, i) => expect(r.line, `log ${i}`).toBe(7)))
  it('finds 53 spans in all before the cap (within 2)', () => expect(Math.abs(sum('total') - 53)).toBeLessThanOrEqual(2))
  it('shows 45 after the cap, three logs capped (within 2)', () => {
    expect(Math.abs(sum('shown') - 45)).toBeLessThanOrEqual(2)
    expect(rows.filter((r) => r.total > 8)).toHaveLength(3)
  })
  it('has the top group before differ from the one at the lowest point in 18 (within 2)', () => expect(Math.abs(sum('beforeNeLowest') - 18)).toBeLessThanOrEqual(2))
  it('has the top group before differ from the one during in 25 (within 2)', () => expect(Math.abs(sum('beforeNeDuring') - 25)).toBeLessThanOrEqual(2))
})
