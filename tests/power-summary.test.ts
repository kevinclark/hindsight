// The Power tab's Copy summary (src/power/summary-text.ts, src/ui/copy.ts): the plain text the button puts on the
// clipboard, in a ``` fence for Slack. The first part is a synthetic log whose cached grid the tests then change; the
// second reads the team's 2026 event logs (tests/helpers/team-logs.ts) by their place in the sorted list, never by name.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { buildPowerGrid } from '../src/power/battery-model.ts'
import { buildBreakdown } from '../src/power/breakdown.ts'
import { powerReport } from '../src/power/power-report.ts'
import { buildSagSpans } from '../src/power/sag-spans.ts'
import { powerSummaryText } from '../src/power/summary-text.ts'
import { copyText } from '../src/ui/copy.ts'
import { matchWhen } from '../src/match/match.ts'
import { robotName } from '../src/profiles/choose.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'
import { haveLogs } from './helpers/load.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const STATE_KEY = '/RealOutputs/Superstructure/State'

type Opts = { brownout?: number; noCurrents?: boolean }

/** A 40 s log: battery 12 V, enabled 2-12 s, a brownout setting `brownout` V when given. */
function analysisOf(o: Opts = {}) {
  const t = Array.from({ length: 41 }, (_, i) => i)
  const series = (name: string, v: (i: number) => number | boolean, type = 'double'): FixtureEntry => ({ name, type, records: t.map((i) => [i, v(i)]) })
  const entries: FixtureEntry[] = [
    series('/DriverStation/Enabled', (i) => i >= 2 && i < 12, 'boolean'),
    series('/SystemStats/BatteryVoltage', () => 12),
  ]
  if (!o.noCurrents) {
    entries.push(
      series('/Intake/Roller Leader/SupplyCurrentAmps', () => 3),
      series('/Intake/Roller Leader/Connected', () => true, 'boolean'),
      series('/Drum/Flywheel/Leader/SupplyCurrentAmps', () => 10),
      series('/Drum/Flywheel/Leader/Connected', () => true, 'boolean'),
    )
  }
  if (o.brownout !== undefined) entries.push(series('/SystemStats/BrownoutVoltage', () => o.brownout!))
  entries.push({ name: STATE_KEY, type: 'string', records: [[0, 'IDLE'], [2, 'SHOOT']] })
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0]
}
const redo = (m: { cache: Map<string, unknown> }) => m.cache.delete('power:report')
/** A match with a 6 V brownout setting (line 7 V) and a 6.5 V dip of 10 samples at grid sample 300. */
function dipped() {
  const match = analysisOf({ brownout: 6 }).match
  const g = buildPowerGrid(match)!
  g.volts.fill(6.5, 300, 310)
  redo(match)
  return match
}
const lines = (s: string | null) => (s ?? '').split('\n')

describe('powerSummaryText on a synthetic match', () => {
  const match = dipped()
  match.event = 'TEST'
  match.matchLabel = 'Qualification 7'
  const text = powerSummaryText(match)!
  const L = lines(text)
  const p = powerReport(match)!
  const b = buildBreakdown(match)!
  const sag = buildSagSpans(match)!

  it('is wrapped in a leading and a trailing ``` line', () => {
    expect(text).not.toBeNull()
    expect(L[0]).toBe('```')
    expect(L[L.length - 1]).toBe('```')
    expect(L.filter((l) => l === '```')).toHaveLength(2)
  })
  it('opens with the match as the review header names it: robot, event, match label', () => {
    expect(L[1]).toBe(`${robotName(match.profile.name, match.profileChoice)} · TEST · Qualification 7`)
  })
  it('names a match with no label "Match", as the report header does', () => {
    const m = analysisOf({ brownout: 6 }).match
    expect(lines(powerSummaryText(m)!)[1]).toBe(`${robotName(m.profile.name, m.profileChoice)} · Match`)
  })
  it('gives lowest voltage with when, margin, sag line, charge and energy, in that order, with the tab\'s decimals', () => {
    const at = (needle: string) => L.findIndex((l) => l.includes(needle))
    const order = ['Lowest voltage', 'Margin to brownout', 'Under 7 V', 'Charge drawn', 'Energy']
    const idx = order.map(at)
    idx.forEach((i, k) => expect(i, order[k]).toBeGreaterThan(0))
    expect([...idx].sort((x, y) => x - y)).toEqual(idx)
    expect(L[idx[0]]).toContain(`${p.minVolts.toFixed(2)} V`)
    expect(L[idx[0]]).toContain(matchWhen(match, p.minAt))
    expect(L[idx[1]]).toContain(`${p.marginVolts.toFixed(2)} V`)
    expect(L[idx[1]]).toContain(`setting ${p.brownoutVolts} V`)
    expect(L[idx[2]]).toContain(`${sag.secondsUnderLine.toFixed(1)} s`)
    expect(L[idx[2]]).toContain('1 sag')
    expect(L[idx[3]]).toContain(`${p.chargeAh.toFixed(2)} Ah`)
    expect(L[idx[4]]).toContain(`${b.totalWh.toFixed(1)} Wh`)
  })
  it('has one line per breakdown row, in the rows\' order, with Wh, share, P90 and peak as the tab shows them', () => {
    const h = L.findIndex((l) => l.startsWith('Group'))
    expect(h).toBeGreaterThan(0)
    const rows = L.slice(h + 1, L.length - 1)
    expect(rows).toHaveLength(b.rows.length)
    // Cells by the header's column ends, so a blank cell stays a blank cell
    const hd = L[h]
    const ends = ['Wh', 'Share', 'P90 A', 'Peak A'].map((w) => hd.indexOf(w) + w.length)
    b.rows.forEach((r, i) => {
      expect(rows[i].startsWith(r.name), r.name).toBe(true)
      const cell = (k: number) => rows[i].slice(k === 0 ? r.name.length : ends[k - 1], ends[k]).trim()
      expect(cell(0)).toBe(r.wh.toFixed(1))
      expect(cell(1)).toBe(`${((100 * r.wh) / b.totalWh).toFixed(0)} %`)
      expect(cell(2)).toBe(r.p90 === null ? '' : r.p90.toFixed(1))
      expect(cell(3)).toBe(r.peak === null ? '' : r.peak.toFixed(1))
    })
  })
  it('leaves a field blank where the row has none: the other-loads row has no P90 or peak', () => {
    const other = b.rows.find((r) => r.kind === 'other')!
    const l = L.find((x) => x.startsWith(other.name))!
    expect(l.slice(other.name.length).trim().split(/\s{2,}/)).toHaveLength(2)
  })
  it('lines the columns up: each number ends under the end of its column heading', () => {
    const h = L.find((l) => l.startsWith('Group'))!
    const first = L[L.findIndex((l) => l.startsWith('Group')) + 1]
    for (const head of ['Wh', 'Share']) {
      const end = h.indexOf(head) + head.length
      expect(first[end - 1], head).not.toBe(' ')
      expect(first[end] ?? ' ', head).toBe(' ')
    }
  })
})

describe('powerSummaryText: the two fallbacks of the sag line', () => {
  it('says "never under 7 V" when the match stays above the line', () => {
    const m = analysisOf({ brownout: 6 }).match
    const l = lines(powerSummaryText(m)!).find((x) => x.includes('Under 7 V') || x.includes('7 V'))!
    expect(l).toContain('never under 7 V')
  })
  it('says "no brownout setting" when the log has none', () => {
    const m = analysisOf().match
    const text = powerSummaryText(m)!
    expect(text).toContain('no brownout setting')
    expect(text).not.toContain('never under')
  })
})

describe('powerSummaryText: the under-line line says what it counts', () => {
  const under = (m: ReturnType<typeof dipped>) => lines(powerSummaryText(m)!).find((x) => x.startsWith('Under ') || x.startsWith('Time under'))!
  it('labels stretches mode "Under 7 V (stretches ≥ 0.04 s)" so it is not read as the tab\'s KPI', () => {
    const l = under(dipped())
    expect(l).toMatch(/^Under 7 V \(stretches ≥ 0\.04 s\)\s+\d+\.\d s, 1 sag$/)
  })
  it('says "only dips shorter than 0.04 s" when the lowest point is under the line but no stretch lasted', () => {
    const m = analysisOf({ brownout: 6 }).match
    buildPowerGrid(m)!.volts[300] = 6.5
    redo(m)
    expect(buildSagSpans(m)!.mode).toBe('lowest-points')
    expect(powerReport(m)!.minVolts).toBeLessThan(7)
    const l = under(m)
    expect(l).toContain('only dips shorter than 0.04 s')
    expect(l).not.toContain('never under')
  })
  it('with no brownout setting, prints the tab\'s own "Time under 7 V" figure', () => {
    const m = analysisOf().match
    const l = under(m)
    expect(l).toMatch(/^Time under 7 V\s+/)
    expect(l).toContain(`${powerReport(m)!.secondsUnder7.toFixed(1)} s`)
    expect(l).not.toContain('no brownout setting')
  })
})

describe('powerSummaryText: floats are rounded and the margin uses the tab\'s ≥', () => {
  const m = analysisOf({ brownout: 6.300000190734863 }).match
  const text = powerSummaryText(m)!
  it('prints the setting and the line to two decimals at most', () => {
    expect(text).not.toMatch(/\d\.\d{3,}/)
    expect(text).toContain('setting 6.3 V')
    expect(text).toContain('Under 7.3 V')
  })
  it('writes "want ≥", not ">="', () => {
    expect(text).toContain('want ≥ ')
    expect(text).not.toContain('>=')
  })
})

describe('summary-text keeps a small import closure', () => {
  it('does not import the review model (matchDateOf lives in src/report/match-date.ts)', () => {
    expect(readFileSync('src/power/summary-text.ts', 'utf8')).not.toMatch(/review-model/)
    expect(readFileSync('src/report/review-model.ts', 'utf8')).toMatch(/match-date\.ts/)
    expect(existsSync('src/report/match-date.ts')).toBe(true)
  })
})

describe('powerSummaryText: nothing to show', () => {
  it('is null for a log with no motor supply currents, so no power grid', () => {
    const m = analysisOf({ noCurrents: true }).match
    expect(buildPowerGrid(m)).toBeNull()
    expect(powerSummaryText(m)).toBeNull()
  })
})

describe('copyText: the clipboard, then the select-and-copy fallback (the one FixPreview and the Power tab share)', () => {
  afterEach(() => vi.unstubAllGlobals())
  const fakeDoc = (exec: () => boolean) => {
    const box = { value: '', style: { cssText: '' }, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }
    const before = { focus: vi.fn() }
    const doc = { createElement: vi.fn(() => box), body: { appendChild: vi.fn() }, execCommand: vi.fn(exec), activeElement: before }
    return { box, doc, before }
  }
  it('uses the clipboard when it works', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })
  it('falls back to a hidden textarea and execCommand when the clipboard throws', async () => {
    const { box, doc } = fakeDoc(() => true)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    vi.stubGlobal('document', doc)
    expect(await copyText('hello')).toBe(true)
    expect(box.value).toBe('hello')
    expect(box.select).toHaveBeenCalled()
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(box.remove).toHaveBeenCalled()
  })
  it('is false when both fail, and still removes the textarea', async () => {
    const { box, doc } = fakeDoc(() => { throw new Error('no') })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    vi.stubGlobal('document', doc)
    expect(await copyText('hello')).toBe(false)
    expect(box.remove).toHaveBeenCalled()
  })
  it('gives focus back to the element that had it, after a copy and after a failed one', async () => {
    for (const exec of [() => true, () => { throw new Error('no') }]) {
      const { doc, before } = fakeDoc(exec)
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
      vi.stubGlobal('document', doc)
      await copyText('hello')
      expect(before.focus).toHaveBeenCalledTimes(1)
    }
  })
  it('does not touch focus when the clipboard worked', async () => {
    const { doc, before } = fakeDoc(() => true)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    vi.stubGlobal('document', doc)
    await copyText('hello')
    expect(before.focus).not.toHaveBeenCalled()
  })
})

// ---- the team's 2026 event logs ----
const DIR = teamPath(TEAM.event2026)
const have = existsSync(DIR) && haveLogs
if (!have) console.warn('SKIPPED the 2026 event part of power-summary.test.ts: list its folder (event2026) in tests/helpers/team-logs.ts')

describe.skipIf(!have)('the summary on the 8 logs of the team\'s 2026 event parses back to the breakdown', () => {
  const files = have ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')) : []
  const matches = files.map((f) => analyzeFiles([{ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) }]).analyses[0].match)
  it('has the 8 logs', () => expect(files).toHaveLength(8))
  it('gives the same Wh per group as the breakdown, to the shown decimal, in every log', () => {
    matches.forEach((m, i) => {
      const b = buildBreakdown(m)!
      const L = lines(powerSummaryText(m)!)
      expect(L[0], `log ${i}`).toBe('```')
      const h = L.findIndex((l) => l.startsWith('Group'))
      const rows = L.slice(h + 1, L.length - 1)
      expect(rows, `log ${i} rows`).toHaveLength(b.rows.length)
      b.rows.forEach((r, k) => {
        expect(rows[k].startsWith(r.name), `log ${i} ${r.name}`).toBe(true)
        expect(rows[k].slice(r.name.length).trim().split(/\s{2,}/)[0], `log ${i} ${r.name}`).toBe(r.wh.toFixed(1))
      })
      expect(L.find((l) => l.startsWith('Energy')), `log ${i} total`).toContain(`${b.totalWh.toFixed(1)} Wh`)
    })
  })
  it('puts slice 3\'s time under the line on the sag line, never above the tab\'s KPI', () => {
    matches.forEach((m, i) => {
      const sag = buildSagSpans(m)!
      const kpi = powerReport(m)!.secondsUnder7
      const l = lines(powerSummaryText(m)!).find((x) => x.startsWith('Under ') || x.startsWith('Time under'))!
      if (sag.mode === 'stretches') {
        expect(l, `log ${i}`).toContain('(stretches ≥ 0.04 s)')
        expect(l, `log ${i}`).toContain(`${sag.secondsUnderLine.toFixed(1)} s, ${sag.totalSpans} ${sag.totalSpans === 1 ? 'sag' : 'sags'}`)
        expect(sag.secondsUnderLine, `log ${i}`).toBeLessThanOrEqual(kpi + 1e-9)
      } else {
        expect(l, `log ${i}`).not.toContain('never under 7 V') // none of these logs is a clean one unless its minimum is above the line
      }
    })
  })
})
