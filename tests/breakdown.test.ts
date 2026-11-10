// Where the power went (src/power/breakdown.ts): energy, running time and current per motor group, and per robot state.
// The first part is a synthetic log whose grid the tests then change; the second reads the team's 2026 event logs
// (tests/helpers/team-logs.ts) by their place in the sorted list, never by name.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { buildFindingsJson } from '../src/report/findings-json.ts'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'
import { buildBreakdown, hasStates, type Breakdown } from '../src/power/breakdown.ts'
import { buildPowerGrid, DT } from '../src/power/battery-model.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { profileKeys } from '../src/profiles/choose.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'
import { haveLogs } from './helpers/load.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const STATE_KEY = '/RealOutputs/Superstructure/State'

type Opts = { enabled?: [number, number]; state?: [number, string][]; profile?: RobotProfile; flywheelAmps?: number }

/** A 40 s log: battery 12 V, enabled for `enabled` (default 2-12 s), flywheel leader at 10 A and roller leader at 3 A all the time. */
function analysisOf(o: Opts = {}) {
  const [on, off] = o.enabled ?? [2, 12]
  const t = Array.from({ length: 41 }, (_, i) => i)
  const series = (name: string, v: (i: number) => number | boolean, type = 'double'): FixtureEntry => ({ name, type, records: t.map((i) => [i, v(i)]) })
  const entries: FixtureEntry[] = [
    series('/DriverStation/Enabled', (i) => i >= on && i < off, 'boolean'),
    series('/SystemStats/BatteryVoltage', () => 12),
    series('/Intake/Roller Leader/SupplyCurrentAmps', () => 3),
    series('/Intake/Roller Leader/Connected', () => true, 'boolean'),
    series('/Drum/Flywheel/Leader/SupplyCurrentAmps', () => o.flywheelAmps ?? 10),
    series('/Drum/Flywheel/Leader/Connected', () => true, 'boolean'),
  ]
  if (o.state) entries.push({ name: STATE_KEY, type: 'string', records: o.state })
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], o.profile ?? offseason2026).analyses[0]
}
const synthetic = (o: Opts = {}) => analysisOf(o).match

const row = (b: Breakdown | null, name: string) => b!.rows.find((r) => r.name === name)!
const stateRow = (b: Breakdown | null, group: string, state: string) => row(b, group).states.find((s) => s.name === state)!
const noState = (): RobotProfile => {
  const { robotState: _, ...signals } = offseason2026.signals
  return { ...offseason2026, signals }
}

describe('buildBreakdown on a synthetic log: energy and running time', () => {
  it('is the supply current times the battery voltage, over enabled time: 10 A at 12 V for 10 s is 0.333 Wh', () => {
    const b = buildBreakdown(synthetic())
    expect(b).not.toBeNull()
    expect(row(b, 'Flywheel').wh).toBeCloseTo(10 * 12 * 10 / 3600, 2)
    expect(row(b, 'Intake rollers').wh).toBeCloseTo(3 * 12 * 10 / 3600, 2)
    expect(b!.enabledSeconds).toBeCloseTo(10, 1)
  })
  it('counts a sample as running above 1 A, and takes percentiles over running samples only', () => {
    const match = synthetic()
    const g = buildPowerGrid(match)!
    const fly = g.groups.find((x) => x.name === 'Flywheel')!
    const idx = [...g.enabled].map((e, i) => (e ? i : -1)).filter((i) => i >= 0)
    // Enabled samples: 100 at 0.5 A (not running), 100 at 20 A, the rest at 10 A, and one at exactly 1 A (not running)
    idx.forEach((i, k) => { fly.amps[i] = k < 100 ? 0.5 : k < 200 ? 20 : 10 })
    fly.amps[idx[idx.length - 1]] = 1
    const b = buildBreakdown(match)!
    const f = row(b, 'Flywheel')
    const running = idx.length - 100 - 1
    expect(f.runningSeconds).toBeCloseTo(running * DT, 9)
    expect(f.p50).toBe(10)
    expect(f.p90).toBe(20)
    expect(f.p99).toBe(20)
    expect(f.peak).toBe(20)
  })
  it('leaves out disabled samples', () => {
    const match = synthetic()
    const g = buildPowerGrid(match)!
    g.groups.find((x) => x.name === 'Flywheel')!.amps.fill(10) // also while disabled
    const f = row(buildBreakdown(match), 'Flywheel')
    expect(f.wh).toBeCloseTo(10 * 12 * 10 / 3600, 2)
    expect(f.runningSeconds).toBeCloseTo(10, 1)
  })
  it('skips a sample whose voltage is NaN, for energy and nothing else', () => {
    const match = synthetic()
    const g = buildPowerGrid(match)!
    const idx = [...g.enabled].map((e, i) => (e ? i : -1)).filter((i) => i >= 0)
    for (const i of idx.slice(0, 100)) g.volts[i] = NaN
    const b = buildBreakdown(match)!
    const f = row(b, 'Flywheel')
    expect(Number.isFinite(b.totalWh)).toBe(true)
    expect(f.wh).toBeCloseTo(10 * 12 * (idx.length - 100) * DT / 3600, 9)
    expect(f.runningSeconds).toBeCloseTo(idx.length * DT, 9) // still ran
  })
  it('gives a group that never ran a row of ~0 Wh with null percentiles', () => {
    const b = buildBreakdown(synthetic())!
    const drive = row(b, 'Drive')
    expect(drive).toMatchObject({ wh: 0, runningSeconds: 0, p50: null, p90: null, p99: null, peak: 0 })
  })
  it('adds an "Other loads (assumed 3 A)" row with energy only', () => {
    const b = buildBreakdown(synthetic())!
    const o = row(b, 'Other loads (assumed 3 A)')
    expect(o.wh).toBeCloseTo(3 * 12 * 10 / 3600, 2)
    expect(o).toMatchObject({ runningSeconds: null, p50: null, p90: null, p99: null })
    expect(o.states).toEqual([])
  })
  it('with a measured total and no motor currents, has one "Whole robot (measured)" row from the grid\'s amps', () => {
    const match = synthetic()
    const g = buildPowerGrid(match)!
    g.currentFrom = 'a measured total'
    g.amps.fill(40)
    const b = buildBreakdown(match)!
    expect(b.rows.map((r) => r.name)).toEqual(['Whole robot (measured)'])
    expect(b.rows[0].wh).toBeCloseTo(40 * 12 * 10 / 3600, 2)
    expect(b.rows[0].p50).toBe(40)
    expect(b.totalWh).toBeCloseTo(b.rows[0].wh, 9)
  })
  it('sorts rows by energy, largest first, and totals them', () => {
    const b = buildBreakdown(synthetic())!
    const whs = b.rows.map((r) => r.wh)
    expect(whs).toEqual([...whs].sort((x, y) => y - x))
    expect(b.rows[0].name).toBe('Flywheel')
    expect(b.totalWh).toBeCloseTo(whs.reduce((s, x) => s + x, 0), 9)
  })
  it('is cached under power:breakdown, and null when there is no power grid', () => {
    const match = synthetic()
    const b = buildBreakdown(match)
    expect(buildBreakdown(match)).toBe(b)
    expect(match.cache.has('power:breakdown')).toBe(true)
    // A log with no battery voltage has no grid
    const noVolts = analyzeFiles([{ name: 'x.wpilog', bytes: writeWpilog([{ name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [1, true]] }]) }], offseason2026).analyses[0].match
    expect(buildBreakdown(noVolts)).toBeNull()
  })
})

describe('the view-only state key', () => {
  it('is set on the 2026 offseason profile, which has no stateMachine, and is not in the fit/coverage key list', () => {
    expect(offseason2026.signals.robotState).toBe(STATE_KEY)
    expect(offseason2026.stateMachine).toBeUndefined()
    expect(profileKeys(offseason2026)).not.toContain(STATE_KEY)
  })
})

describe('buildBreakdown on a synthetic log: by robot state', () => {
  const STATES: [number, string][] = [[4, 'INTAKE'], [8, 'SCORE'], [11, 'INTAKE']]
  it('holds the last state value: a sample takes the state at or before it; before the first value is "No state logged"', () => {
    const b = buildBreakdown(synthetic({ state: STATES }))!
    const f = row(b, 'Flywheel')
    const sec = (s: string) => stateRow(b, 'Flywheel', s).runningSeconds!
    expect(sec('No state logged')).toBeCloseTo(2, 1) // enabled 2-4
    expect(sec('SCORE')).toBeCloseTo(3, 1) // 8-11
    expect(sec('INTAKE')).toBeCloseTo(5, 1) // 4-8 and 11-12
    expect(f.states.map((s) => s.name)).toEqual(['INTAKE', 'SCORE', 'No state logged']) // by energy
    expect(b.stateNote).toBeNull()
  })
  it('sorts each group\'s state rows by energy', () => {
    const b = buildBreakdown(synthetic({ state: [[0, 'A'], [3, 'B'], [8, 'C'], [10, 'A']] }))!
    for (const g of b.rows) {
      const whs = g.states.map((s) => s.wh)
      expect(whs).toEqual([...whs].sort((x, y) => y - x))
    }
    expect(row(b, 'Flywheel').states[0].name).toBe('B') // 5 s
  })
  it('folds states with under 1 s of running into one "Other states" row', () => {
    const b = buildBreakdown(synthetic({ state: [[0, 'LONG'], [6, 'BLIP'], [6.5, 'LONG'], [9, 'BLIP2'], [9.4, 'LONG']] }))!
    const f = row(b, 'Flywheel')
    expect(f.states.map((s) => s.name).sort()).toEqual(['LONG', 'Other states'])
    expect(stateRow(b, 'Flywheel', 'Other states').runningSeconds).toBeCloseTo(0.9, 1)
    expect(stateRow(b, 'Flywheel', 'Other states').p50).toBe(10)
    // A group that never ran has every state under 1 s: one "Other states" row, so its states still add up to the group
    expect(row(b, 'Drive').states.map((s) => s.name)).toEqual(['Other states'])
  })
  it('has no state rows and says why when the profile has no state key', () => {
    const b = buildBreakdown(synthetic({ profile: noState(), state: STATES }))!
    expect(b.rows.every((r) => r.states.length === 0)).toBe(true)
    expect(b.stateNote).toMatch(/no state/i)
    expect(row(b, 'Flywheel').wh).toBeGreaterThan(0)
  })
  it('has no state rows and says why when the log lacks the state key', () => {
    const b = buildBreakdown(synthetic())!
    expect(b.rows.every((r) => r.states.length === 0)).toBe(true)
    expect(b.stateNote).toContain(STATE_KEY)
  })
})

/** The identity checks every log must pass: the groups add up to the grid's total, and the states add up to their group. */
function identity(b: Breakdown, g: NonNullable<ReturnType<typeof buildPowerGrid>>) {
  let total = 0
  for (let i = 0; i < g.t.length; i++) if (g.enabled[i] && Number.isFinite(g.volts[i])) total += g.amps[i] * g.volts[i] * DT / 3600
  const rowsWh = b.rows.reduce((s, r) => s + r.wh, 0)
  const totalErr = total === 0 ? 0 : Math.abs(rowsWh - total) / total
  let stateErr = 0
  let runningErr = 0
  for (const r of b.rows) {
    if (!r.states.length) continue
    const sw = r.states.reduce((s, x) => s + x.wh, 0)
    stateErr = Math.max(stateErr, r.wh === 0 ? Math.abs(sw) : Math.abs(sw - r.wh) / r.wh)
    runningErr = Math.max(runningErr, Math.abs(r.states.reduce((s, x) => s + (x.runningSeconds ?? 0), 0) - (r.runningSeconds ?? 0)))
  }
  return { totalErr, stateErr, runningErr }
}

describe('buildBreakdown identities on a synthetic log with varying currents', () => {
  it('groups + other loads = the grid total within 1 %; each group\'s states = the group; their running seconds add up', () => {
    const states: [number, string][] = []
    for (let k = 0; k < 30; k++) states.push([k * 1.3, ['IDLE', 'INTAKE', 'SCORE', 'FEED'][k % 4]])
    const match = synthetic({ enabled: [3, 37], state: states })
    const g = buildPowerGrid(match)!
    g.groups.forEach((gr, gi) => {
      for (let i = 0; i < g.t.length; i++) {
        const x = (Math.sin(i * 0.013 * (gi + 1)) + 1) * 15 * (gi % 2 === 0 ? 1 : 0.2) // 0-30 A, sometimes under 1 A
        gr.amps[i] = x
      }
    })
    g.amps.fill(match.profile.power.otherLoadsAmps)
    for (const gr of g.groups) for (let i = 0; i < g.amps.length; i++) g.amps[i] += gr.amps[i]
    const id = identity(buildBreakdown(match)!, g)
    expect(id.totalErr).toBeLessThan(0.01)
    expect(id.stateErr).toBeLessThan(0.01)
    expect(id.runningErr).toBeLessThan(1e-9)
  })
})

// ---- the team's 2026 event logs ----
const DIR = teamPath(TEAM.event2026)
const have = existsSync(DIR) && haveLogs
if (!have) console.warn('SKIPPED the 2026 event part of breakdown.test.ts: list its folder (event2026) in tests/helpers/team-logs.ts')

describe.skipIf(!have)('the breakdown on the 8 logs of the team\'s 2026 event', () => {
  const files = have ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')) : []
  const analyses = have ? files.map((f) => analyzeFiles([{ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) }]).analyses[0]) : []
  const results = analyses.map((a) => ({ b: buildBreakdown(a.match), g: buildPowerGrid(a.match) }))

  it('has the 8 logs, each with a breakdown', () => {
    expect(files).toHaveLength(8)
    results.forEach((r, i) => expect(r.b, `log ${i}`).not.toBeNull())
  })
  it('passes the identity checks on every log (printed: the worst error per log)', () => {
    const lines: string[] = ['log | groups vs grid total | worst group states vs group | worst running s']
    results.forEach((r, i) => {
      const id = identity(r.b!, r.g!)
      lines.push(`${i} | ${(id.totalErr * 100).toFixed(4)} % | ${(id.stateErr * 100).toFixed(4)} % | ${id.runningErr.toExponential(1)}`)
      expect(id.totalErr, `log ${i} total`).toBeLessThan(0.01)
      expect(id.stateErr, `log ${i} states`).toBeLessThan(0.01)
      expect(id.runningErr, `log ${i} running`).toBeLessThan(1e-6)
    })
    console.log(lines.join('\n'))
  })
  it('has state rows in every log', () => {
    results.forEach((r, i) => {
      expect(r.b!.stateNote, `log ${i}`).toBeNull()
      expect(r.b!.rows.some((x) => x.states.length > 0), `log ${i}`).toBe(true)
    })
  })
  it('has shooting states under Drive and Flywheel in the logs at index 3 and 4 (sorted by file name, from 0)', () => {
    for (const i of [3, 4]) {
      for (const group of ['Drive', 'Flywheel']) {
        const r = results[i].b!.rows.find((x) => x.name === group)!
        const names = r.states.map((s) => s.name)
        expect(names.some((n) => /^(SPIN_UP_SCORE|SCORE|FEED)/.test(n)), `log ${i} ${group}: ${names.join(', ')}`).toBe(true)
      }
    }
  })
  it('prints the group rows (no assertion on the values)', () => {
    const lines = ['log | group | Wh | running s | p90 A | top 3 states by Wh (Drive, Flywheel)']
    results.forEach((r, i) => {
      for (const x of r.b!.rows) {
        const top = x.name === 'Drive' || x.name === 'Flywheel' ? x.states.slice(0, 3).map((s) => `${s.name} ${s.wh.toFixed(2)}`).join('; ') : ''
        lines.push(`${i} | ${x.name} | ${x.wh.toFixed(2)} | ${x.runningSeconds === null ? '-' : x.runningSeconds.toFixed(1)} | ${x.p90 === null ? '-' : x.p90.toFixed(1)} | ${top}`)
      }
    })
    console.log(lines.join('\n'))
  })
})

describe('a group row has a state toggle only when it has a state worth opening', () => {
  it('has one for a group with a real state, not for one with only the fold or "No state logged"', () => {
    const b = buildBreakdown(synthetic({ state: [[0, 'INTAKE'], [6, 'SCORE']] }))!
    expect(hasStates(row(b, 'Flywheel'))).toBe(true)
    expect(hasStates(row(b, 'Drive'))).toBe(false) // never ran: only "Other states"
  })
  it('has none for a group that never ran when the state is first logged after the robot is enabled', () => {
    const b = buildBreakdown(synthetic({ state: [[5, 'INTAKE']] }))!
    const drive = row(b, 'Drive')
    expect(drive.states.map((s) => s.name)).toContain('No state logged')
    expect(hasStates(drive)).toBe(false)
    expect(hasStates(row(b, 'Flywheel'))).toBe(true)
  })
})

describe('the expanded rows (the component cannot be opened in a server render, so this tests the rows model it lists)', () => {
  it('lists, for an opened group, its state rows largest energy first, adding up to the group', () => {
    const b = buildBreakdown(synthetic({ state: [[0, 'INTAKE'], [6, 'SCORE']] }))!
    const f = row(b, 'Flywheel')
    expect(f.states.map((s) => s.name)).toEqual(['INTAKE', 'SCORE'].sort((x, y) => stateRow(b, 'Flywheel', y).wh - stateRow(b, 'Flywheel', x).wh))
    expect(f.states.reduce((s, x) => s + x.wh, 0)).toBeCloseTo(f.wh, 9)
    expect(stateRow(b, 'Flywheel', 'INTAKE').runningSeconds).toBeCloseTo(4, 1) // enabled 2-6
    expect(stateRow(b, 'Flywheel', 'SCORE').runningSeconds).toBeCloseTo(6, 1) // 6-12
  })
})

describe('the Power tab\'s "Where the power went" table', () => {
  const renderTab = async (analysis: ReturnType<typeof analysisOf>) => {
    const { render } = await import('svelte/server')
    const { default: PowerTab } = await import('../src/ui/PowerTab.svelte')
    return render(PowerTab, { props: { analysis } }).body
  }
  it('renders the group rows, the note and the state toggle, and the note\'s sentences are joined with single spaces', async () => {
    const html = await renderTab(analysisOf({ state: [[0, 'INTAKE'], [6, 'SCORE']] }))
    expect(html).toContain('Where the power went')
    expect(html).toContain('Flywheel')
    expect(html).toContain('Other loads (assumed 3 A)')
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/)
    expect(html.indexOf('Where the power went')).toBeLessThan(html.indexOf('Voltage and current over the match'))
    const note = html.slice(html.indexOf('Energy is supply current'), html.indexOf('</p>', html.indexOf('Energy is supply current'))).replace(/<!--.*?-->/g, '')
    expect(note).toContain('while enabled (10 s, 0.')
    expect(note).toContain(' Wh in all). A group\'s currents are its motors added together (Drive\'s P90 is all its motors at once, not one motor against a per-motor limit). Share is the share of the whole match\'s energy, state rows too. A group is running above 1 A (an assumed line). Everything not on a motor controller is 3 A, assumed. Open a group')
    expect(note).not.toMatch(/ {2,}|\n/)
  })
  it('says the currents are each group\'s motors added together, and that Share is of the whole match\'s energy, state rows too', async () => {
    const html = (await renderTab(analysisOf({ state: [[0, 'INTAKE']] }))).replace(/<!--.*?-->/g, '')
    expect(html).toContain('motors added together')
    expect(html).toMatch(/Share is the share of the whole match.s energy, state rows too/)
  })
  it('puts every Wh number after a fixed-width track that holds the bar, so numbers start at one x', async () => {
    const html = await renderTab(analysisOf({ state: [[0, 'INTAKE']] }))
    const cells = [...html.matchAll(/<td class="wh[^"]*">(.*?)<\/td>/g)].map((m) => m[1])
    expect(cells.length).toBeGreaterThanOrEqual(3)
    for (const c of cells) expect(c).toMatch(/^<span class="track[^"]*"><span class="bar[^"]*"[^>]*><\/span><\/span><span class="num[^"]*">[\d.]+<\/span>$/)
    const css = readFileSync(new URL('../src/ui/PowerTab.svelte', import.meta.url), 'utf8')
    expect(css).toMatch(/\.track\s*\{[^}]*display:\s*inline-block[^}]*width:\s*5rem/)
    expect(css).toMatch(/\.breakdown td, \.breakdown th\s*\{[^}]*vertical-align:\s*middle/)
  })
  it('shows one line instead of a table of 0.0 Wh rows when the robot was never enabled', async () => {
    const html = await renderTab(analysisOf({ enabled: [50, 60] }))
    expect(html).toContain('The robot was never enabled in this log, so there is no energy to split.')
    expect(html).not.toMatch(/<table class="breakdown/)
    expect(html).not.toContain('Open a group')
  })
  it('says "Open a group" only when a row has a toggle', async () => {
    expect(await renderTab(analysisOf({ state: [[0, 'INTAKE']] }))).toContain('Open a group')
    expect(await renderTab(analysisOf())).not.toContain('Open a group') // no state signal in the log: no toggles
  })
})

describe('findings.json power.breakdown', () => {
  const json = (match: ReturnType<typeof synthetic>, a = analysisOf({ state: [[0, 'INTAKE'], [6, 'SCORE']] })) => {
    void match
    return buildFindingsJson(a.match, a.report) as unknown as { power: { breakdown: any } }
  }
  it('has the totals, rounded, one row per group with its states, and measured false', () => {
    const bd = json(synthetic()).power.breakdown
    expect(bd.measured).toBe(false)
    expect(bd.enabledSeconds).toBeCloseTo(10, 1)
    expect(Number.isInteger(bd.totalWh * 1000)).toBe(true) // 3 decimals
    const fly = bd.rows.find((r: any) => r.name === 'Flywheel')
    expect(Object.keys(fly).sort()).toEqual(['name', 'p50Amps', 'p90Amps', 'p99Amps', 'peakAmps', 'runningSeconds', 'states', 'wh'])
    expect(fly.wh).toBe(+(fly.wh).toFixed(3))
    expect(fly.p50Amps).toBe(10)
    expect(fly.states.map((s: any) => s.state).sort()).toEqual(['INTAKE', 'SCORE'])
    expect(Object.keys(fly.states[0]).sort()).toEqual(['p50Amps', 'p90Amps', 'p99Amps', 'peakAmps', 'runningSeconds', 'state', 'wh'])
    const other = bd.rows.find((r: any) => r.name.startsWith('Other loads'))
    expect(other).toMatchObject({ runningSeconds: null, p50Amps: null, peakAmps: null, states: [] })
    expect(bd.note).toContain('other loads 3 A (assumed)')
  })
  it('on the measured-total path says measured and drops the "other loads" clause', () => {
    const a = analysisOf()
    const g = buildPowerGrid(a.match)!
    g.currentFrom = 'a measured total'
    g.amps.fill(40)
    const bd = json(a.match, a).power.breakdown
    expect(bd.measured).toBe(true)
    expect(bd.rows.map((r: any) => r.name)).toEqual(['Whole robot (measured)'])
    expect(bd.note).not.toContain('other loads')
  })
})

describe.skipIf(!have)('the breakdown against a recomputation straight from the raw records (team logs, no grid or breakdown internals)', () => {
  const files = have ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')) : []
  it('gives each group\'s Wh within 1 % on every log (printed: the worst error per log)', () => {
    const lines = ['log | worst group Wh error']
    files.forEach((f, i) => {
      const bytes = new Uint8Array(readFileSync(`${DIR}/${f}`))
      const a = analyzeFiles([{ name: f, bytes }]).analyses[0]
      const b = buildBreakdown(a.match)!
      const profile = a.match.profile
      const log = openWpilog(bytes)
      const en = readNumbers(log, '/DriverStation/Enabled')!
      const volts = readNumbers(log, '/SystemStats/BatteryVoltage')!
      // hold-last value of a series at time x; `before` ahead of its first record
      const at = (s: { t: ArrayLike<number>; v: ArrayLike<number> }, cur: { k: number }, x: number, before: number) => {
        while (cur.k + 1 < s.t.length && s.t[cur.k + 1] <= x) cur.k++
        return cur.k < 0 ? before : s.v[cur.k]
      }
      const t0 = en.t[0]
      const t1 = volts.t[volts.t.length - 1]
      const n = Math.floor((t1 - t0) / 0.02)
      const cEn = { k: -1 }, cV = { k: -1 }
      const motors = profile.motorGroups.flatMap((gr) => gr.motors.filter((m) => m.supplyCurrent).map((m) => {
        const cur = readNumbers(log, m.supplyCurrent!)
        const con = m.connected ? readNumbers(log, m.connected) : null
        return cur && { group: gr.name, cur, con, kc: { k: -1 }, kn: { k: -1 } }
      })).filter((m): m is NonNullable<typeof m> => !!m)
      const wh = new Map<string, number>()
      for (let k = 0; k < n; k++) {
        const x = t0 + k * 0.02
        const e = at(en, cEn, x, 0)
        const v = at(volts, cV, x, NaN)
        for (const m of motors) {
          const amps = at(m.cur, m.kc, x, NaN)
          const on = m.con ? at(m.con, m.kn, x, NaN) : NaN
          if (!(e > 0.5) || on === 0 || !Number.isFinite(v) || !Number.isFinite(amps)) continue
          wh.set(m.group, (wh.get(m.group) ?? 0) + Math.max(0, amps) * v * 0.02 / 3600)
        }
      }
      let worst = 0
      for (const [group, mine] of wh) {
        const r = b.rows.find((x) => x.name === group)!
        const err = mine === 0 ? Math.abs(r.wh) : Math.abs(r.wh - mine) / mine
        worst = Math.max(worst, err)
        expect(err, `log ${i} ${group}: breakdown ${r.wh.toFixed(3)} Wh, raw ${mine.toFixed(3)} Wh`).toBeLessThan(0.01)
      }
      expect(wh.size, `log ${i} groups with current`).toBeGreaterThan(0)
      lines.push(`${i} | ${(worst * 100).toFixed(4)} %`)
    })
    console.log(lines.join('\n'))
  })
})
