// Each motor's drag (src/power/drag.ts): median stator current at a steady speed, per speed band. The first part is
// synthetic series; the second reproduces the team's 2026 event reference numbers (tests/helpers/team-logs.ts).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { bandEdges, bandOf, buildDrag, dragBands } from '../src/power/drag.ts'
import { joinDrag } from '../src/session/summary.ts'
import { TEAM, teamPath } from './helpers/team-logs.ts'
import { analyzeFixture, haveLogs } from './helpers/load.ts'

const FIXTURE = 'flywheel-spinups'
const N = 1000 // 20 s at 0.02 s
const flat = (x: number, n = N) => new Float64Array(n).fill(x)
const ones = (n = N) => flat(1, n)

describe('dragBands on synthetic series', () => {
  it('takes the median |stator| of steady samples, with the seconds they cover', () => {
    const b = dragBands(flat(-20), flat(-6), ones(), ones())
    expect(b).toHaveLength(1)
    expect(b[0].amps).toBe(6)
    // The first and last 0.1 s have no sample on both sides.
    expect(b[0].seconds).toBeCloseTo((N - 10) * 0.02, 6)
  })
  it('leaves out samples while the motor is off CAN, even when its readings stay frozen', () => {
    const conn = ones()
    conn.fill(0, 300, 700) // 8 s off CAN; the series below keep their frozen value
    const stator = flat(1); stator.fill(9, 0, 300); stator.fill(9, 700)
    const b = dragBands(flat(20), stator, conn, ones())
    expect(b).toHaveLength(1)
    expect(b[0].amps).toBe(9)
    // 600 samples less the 5 on each side of the gap that lack a connected neighbour, and the 10 at the ends
    expect(b[0].seconds).toBeCloseTo((N - 400 - 10 - 10) * 0.02, 6)
    // Off CAN the whole time: nothing
    expect(dragBands(flat(20), flat(1), flat(0), ones())).toEqual([])
  })
  it('counts a sample only if the motor is connected at t-0.1, t and t+0.1 s', () => {
    const conn = ones(); conn[500] = 0 // one dropped sample
    const b = dragBands(flat(20), flat(5), conn, ones())
    // the dropped sample is the t-0.1, t or t+0.1 neighbour of exactly 3 samples (495, 500, 505)
    expect(b[0].seconds).toBeCloseTo((N - 10 - 3) * 0.02, 6)
  })
  it('counts only enabled time', () => {
    const en = new Float64Array(N); en.fill(1, 0, 400)
    expect(dragBands(flat(20), flat(5), ones(), en)[0].seconds).toBeCloseTo((400 - 5 - 5) * 0.02 - 0.0, 1)
  })
  it('steady means |v| at t+0.1 and t-0.1 differ by at most 2 % of |v| at t, and |v| above 1', () => {
    const at = (a: number, b: number) => {
      const v = flat(20); v[495] = a; v[505] = b // around t = 500
      return dragBands(v, flat(5), ones(), ones())[0].seconds
    }
    const full = (N - 10) * 0.02
    // A change of 0.4 (2 % of 20) is steady; 0.5 is not (the 5 samples whose window holds the spike are lost either way)
    const base = at(20, 20)
    expect(base).toBeCloseTo(full, 6)
    expect(at(20, 20.4)).toBeCloseTo(full, 6)
    expect(at(20, 20.5)).toBeLessThan(full)
    // Sign does not matter: -20 then +20 is the same speed
    expect(at(-20, 20)).toBeCloseTo(full, 6)
    // Below 1 in the motor's unit is standing still
    expect(dragBands(flat(0.9), flat(5), ones(), ones())).toEqual([])
    expect(dragBands(flat(1.01), flat(5), ones(), ones())).toHaveLength(1)
  })
  it('puts speeds in bands with edges at powers of 1.25', () => {
    expect(bandOf(1.25 ** 5)).toBe(5)
    expect(bandOf(1.25 ** 5 * 0.9999)).toBe(4)
    expect(bandOf(1.25 ** 5 * 1.0001)).toBe(5)
    expect(bandOf(1.01)).toBe(0)
    expect(bandEdges(13).lo).toBeCloseTo(18.19, 2)
    expect(bandEdges(13).hi).toBeCloseTo(22.74, 2)
    const b = dragBands(flat(1.25 ** 5 * 1.001), flat(3), ones(), ones())
    expect(b[0]).toMatchObject({ band: 5, lo: bandEdges(5).lo, hi: bandEdges(5).hi })
  })
  it('keeps a band only with 2 s or more of steady running', () => {
    // 30 for `n` samples after the 5 at the start with no neighbour before them, then 10 for the rest: the samples of
    // 30 whose t+0.1 s still reads 30 are steady, and the 5 before the change are not.
    const sec = (n: number) => {
      const s = new Float64Array(N); s.fill(30, 0, n + 10); s.fill(10, n + 10)
      return dragBands(s, flat(4), ones(), ones()).find((x) => x.band === bandOf(30))?.seconds
    }
    expect(sec(100)).toBeCloseTo(2.0, 6) // exactly 2 s: kept
    expect(sec(99)).toBeUndefined() // 1.98 s: dropped
  })
})

describe('joinDrag: one match in several logs', () => {
  const b = (band: number, amps: number, seconds: number) => ({ band, lo: 1.25 ** band, hi: 1.25 ** (band + 1), amps, seconds })
  it('adds the seconds per motor and band, and weighs each piece\'s median by its seconds', () => {
    const j = joinDrag([
      [{ motor: 'A', group: 'G', unit: 'rot/s', bands: [b(13, 5, 6), b(14, 9, 2)] }],
      [{ motor: 'A', group: 'G', unit: 'rot/s', bands: [b(13, 8, 3)] }, { motor: 'B', group: 'G', bands: [b(2, 1, 4)] }],
    ])
    expect(j.map((x) => x.motor)).toEqual(['A', 'B'])
    expect(j[0].bands).toHaveLength(2)
    expect(j[0].bands[0]).toMatchObject({ band: 13, seconds: 9 })
    expect(j[0].bands[0].amps).toBeCloseTo((5 * 6 + 8 * 3) / 9, 9) // 6, not the plain mean 6.5
    expect(j[0].bands[1]).toMatchObject({ band: 14, amps: 9, seconds: 2 })
    expect(j[1]).toMatchObject({ motor: 'B', bands: [{ band: 2, amps: 1, seconds: 4 }] })
  })
})

describe('buildDrag on a match', () => {
  it('is cached under power:drag and returns the same object; a fixture without velocity signals gives bands only for motors that log them', () => {
    const match = analyzeFixture(FIXTURE).analyses[0].match
    const a = buildDrag(match)
    expect(buildDrag(match)).toBe(a)
    expect(match.cache.has('power:drag')).toBe(true)
    for (const d of a) expect(d.bands.every((x) => x.seconds >= 2)).toBe(true)
  })
})

const DIR = teamPath(TEAM.event2026)
const have = existsSync(DIR) && haveLogs
if (!have) console.warn('SKIPPED the 2026 event part of drag.test.ts: list its folder (event2026) in tests/helpers/team-logs.ts')

// The reference: the 2026 event's 8 logs, oldest first (practice, then the qualification matches in the order played), median
// stator A / seconds per band, enabled and on CAN on both sides of the +-0.1 s window, steady, bands at powers of 1.25.
// Rounded to 0.1 A and 1 s.
const REFERENCE: Record<string, [number, number][]> = {
  'leader 18': [[5.0, 13], [5.7, 3], [6.1, 9], [4.9, 7], [5.8, 9], [8.6, 8], [4.4, 9], [8.2, 6]],
  'leader 22': [[8.6, 11], [8.7, 6], [8.9, 8], [8.1, 7], [9.0, 10], [11.0, 7], [7.3, 9], [9.6, 7]],
  'follower 18': [[5.9, 12], [6.5, 3], [5.4, 10], [5.8, 7], [6.5, 9], [1.0, 3], [5.1, 8], [9.1, 7]],
  'follower 22': [[8.5, 11], [8.6, 5], [8.2, 7], [7.8, 7], [7.7, 10], [2.9, 5], [7.1, 10], [10.4, 8]],
}

describe.skipIf(!have)('drag on the 8 logs of the team\'s 2026 event', () => {
  // The files sorted by name come out oldest first on this event (date-stamped names); a log is named here only by its place.
  const files = have ? readdirSync(DIR).sort().filter((f) => f.endsWith('.wpilog')) : []
  const drags = have ? files.map((f) => buildDrag(analyzeFiles([{ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) }]).analyses[0].match)) : []
  const cell = (i: number, who: 'leader' | 'follower', band: 13 | 14) =>
    drags[i].find((d) => d.motor === `Intake roller ${who}`)?.bands.find((b) => b.band === band)

  it('has the 8 logs', () => expect(files).toHaveLength(8))
  for (const [name, cells] of Object.entries(REFERENCE)) {
    it(`reproduces the roller ${name}.x band for every log within 0.1 A and 0.5 s`, () => {
      const [who, b] = name.split(' ') as ['leader' | 'follower', string]
      const band = b === '18' ? 13 : 14
      cells.forEach(([amps, seconds], i) => {
        const c = cell(i, who, band)
        expect(c, `log ${i + 1}`).toBeDefined()
        // The table rounds to 0.1 A, so a reproduction can sit 0.05 A further out
        expect(Math.abs(c!.amps - amps), `log ${i + 1} amps ${c!.amps}`).toBeLessThanOrEqual(0.1 + 1e-9)
        expect(Math.abs(c!.seconds - seconds), `log ${i + 1} seconds ${c!.seconds}`).toBeLessThanOrEqual(0.5)
      })
    })
  }
  it('marks the rollers\' unit and group', () => {
    const d = drags[0].find((x) => x.motor === 'Intake roller leader')!
    expect(d).toMatchObject({ group: 'Intake rollers', unit: 'rot/s' })
  })
})

describe.skipIf(!have)('the Power tab\'s table on one of the team\'s 2026 event logs', () => {
  it('renders "Current at steady speed" with the roller rows and the band edges', async () => {
    const f = readdirSync(DIR).sort().filter((x) => x.endsWith('.wpilog'))[0]
    const analysis = analyzeFiles([{ name: f, bytes: new Uint8Array(readFileSync(`${DIR}/${f}`)) }]).analyses[0]
    const { render } = await import('svelte/server')
    const { default: PowerTab } = await import('../src/ui/PowerTab.svelte')
    const html = render(PowerTab, { props: { analysis } }).body
    expect(html).toContain('Current at steady speed')
    expect(html).toContain('Intake roller leader')
    expect(html).toContain('Intake rollers')
    expect(html).toMatch(/18–23 rot\/s/)
  })
})
