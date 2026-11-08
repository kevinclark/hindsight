// Contract tests for src/power/breakers.ts: each test proves the obligations its name starts with, in
// docs/contracts/breaker-heat.md.
import { expect, test } from 'vitest'
import { BREAKERS, breakerFamily, heat, steadyAmps, tripSeconds, type BreakerEdge, type EdgeName } from '../src/power/breakers.ts'
import { FROZEN } from './helpers/breaker-frozen.ts'

const EDGES: EdgeName[] = ['fast', 'slow']
const everyEdge = BREAKERS.flatMap((f) => EDGES.map((e) => ({ name: `${f.id} ${e}`, family: f, edge: f.edges[e] })))
const constant = (amps: number, n: number) => new Float64Array(n).fill(amps)
const peak = (a: Float64Array) => a.reduce((m, v) => Math.max(m, v), 0)

/** The current (as a share of the rating) whose trip time is `seconds`: tripSeconds falls as current rises. */
function currentFor(seconds: number, edge: BreakerEdge): number {
  let lo = 0.5
  let hi = 60
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tripSeconds(100 * mid, edge) > seconds) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** One flat test per edge: `[BH-nn] title <family> <edge>`. */
const perEdge = (title: string, body: (edge: BreakerEdge) => void) => {
  for (const { name, edge } of everyEdge) test(`${title} ${name}`, () => body(edge))
}

test('[BH-01] the curve table is the published one: five families, each edge frozen to the digit', () => {
  expect(BREAKERS.map((f) => f.id)).toEqual(Object.keys(FROZEN))
  for (const f of BREAKERS) {
    const want = FROZEN[f.id as keyof typeof FROZEN]
    expect(f.kind).toBe(want.kind)
    expect(f.parts).toEqual(want.parts)
    expect(f.ratingsA).toEqual(want.ratingsA)
    expect(Object.keys(f.edges).sort()).toEqual(['fast', 'slow'])
    for (const e of EDGES) {
      const got = f.edges[e]
      const w = want.edges[e]
      expect(got.taus).toEqual(w.taus)
      expect(got.weights).toEqual(w.weights)
      expect(got.tripRatio).toBe(w.tripRatio)
      expect(got.fitError).toEqual(w.fitError)
      expect(got.points).toEqual(w.points)
    }
  }
})

perEdge('[BH-02] a constant current from cold reproduces every datasheet point within the edge\'s recorded error', (edge) => {
  // 0.0005: the recorded errors are rounded to four decimals.
  for (const [percent, seconds] of edge.points) {
    const found = currentFor(seconds, edge)
    const off = Math.abs(found / (percent / 100) - 1)
    expect(off, `${percent} % at ${seconds} s`).toBeLessThanOrEqual(edge.fitError.currentWorst + 0.0005)
  }
})

perEdge('[BH-03] heat 1.0 is the trip, at any rating, from a cold start', (edge) => {
  for (const [percent, rating] of [[200, 40], [200, 120], [300, 10]] as const) {
    const t = tripSeconds(percent, edge)
    const dt = Math.min(0.01, t / 4000)
    const n = Math.round((t * 1.5) / dt)
    const h = heat(constant((rating * percent) / 100, n), dt, rating, edge)
    expect(h[0]).toBeGreaterThan(0)
    expect(h[0]).toBeLessThan(1)
    const at = Math.round(t / dt) - 1
    expect(h[at]).toBeGreaterThan(0.99)
    expect(h[at]).toBeLessThan(1.01)
    expect(h[Math.round(t / dt / 2)]).toBeLessThan(1)
    expect(h[n - 1]).toBeGreaterThan(1)
  }
})

test('[BH-03] the size of the current counts, not its sign', () => {
  const edge = breakerFamily('rev-ato')!.edges.fast
  expect(heat(constant(-80, 100), 0.02, 40, edge)).toEqual(heat(constant(80, 100), 0.02, 40, edge))
})

perEdge('[BH-04] heat cools when the current drops', (edge) => {
  const amps = new Float64Array(3000)
  amps.fill(90, 0, 500) // 10 s of 90 A on a 40 A rating (225 %)
  const h = heat(amps, 0.02, 40, edge)
  for (let i = 501; i < amps.length; i++) expect(h[i]).toBeLessThanOrEqual(h[i - 1])
  expect(h[2999]).toBeLessThan(h[499] / 2)
  expect(h[2999]).toBeGreaterThanOrEqual(0)
})

perEdge('[BH-05] heat never decreases under a constant current', (edge) => {
  for (const x of [0.5, 1, 1.5, 3, 8]) {
    const h = heat(constant(40 * x, 4000), 0.02, 40, edge)
    for (let i = 1; i < h.length; i++) expect(h[i]).toBeGreaterThanOrEqual(h[i - 1])
  }
})

perEdge('[BH-06] a stage shorter than the sample step stays bounded (exact step, not Euler)', (edge) => {
  for (const dt of [0.02, 0.5, 2, 30]) {
    const x = 5
    const h = heat(constant(40 * x, 200), dt, 40, edge)
    const ceiling = (x * x) / (edge.tripRatio * edge.tripRatio)
    for (const v of h) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(ceiling * (1 + 1e-9))
    }
  }
})

perEdge('[BH-07] a history sampled at half the rate gives the same peak within 2 %', (edge) => {
  // 50 Hz: a drive-like history of 0.8 s bursts to 3x the rating with rests, for a minute.
  const fine = new Float64Array(3000)
  for (let i = 0; i < fine.length; i++) fine[i] = Math.floor(i / 40) % 3 === 0 ? 120 : 30
  const coarse = Float64Array.from({ length: 1500 }, (_, i) => fine[2 * i])
  const a = peak(heat(fine, 0.02, 40, edge))
  const b = peak(heat(coarse, 0.04, 40, edge))
  expect(Math.abs(b / a - 1)).toBeLessThan(0.02)
})

perEdge('[BH-08] tripSeconds: Infinity at or below the long-run limit, finite and falling above it', (edge) => {
  const limit = 100 * edge.tripRatio * Math.sqrt(1 / edge.weights.reduce((s, w) => s + w, 0))
  expect(tripSeconds(limit, edge)).toBe(Infinity)
  expect(tripSeconds(limit * 0.9, edge)).toBe(Infinity)
  expect(tripSeconds(1, edge)).toBe(Infinity)
  let last = Infinity
  for (const x of [1.02, 1.1, 1.5, 2, 4, 8]) {
    const t = tripSeconds(limit * x, edge)
    expect(Number.isFinite(t)).toBe(true)
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(last)
    last = t
  }
})

perEdge('[BH-09] steadyAmps is the constant current that just reaches 100 % in the given seconds', (edge) => {
  let last = Infinity
  for (const [seconds, rating] of [[30, 120], [150, 120], [150, 40]] as const) {
    const amps = steadyAmps(seconds, rating, edge)
    const dt = 0.01
    const h = heat(constant(amps, Math.round(seconds / dt) + 1), dt, rating, edge)
    expect(h[Math.round(seconds / dt) - 1]).toBeGreaterThan(0.99)
    expect(h[Math.round(seconds / dt) - 1]).toBeLessThan(1.01)
    expect(h[Math.round((seconds - 1) / dt)]).toBeLessThan(1)
  }
  for (const s of [10, 60, 150, 600]) {
    const a = steadyAmps(s, 120, edge)
    expect(a).toBeLessThanOrEqual(last) // equal once every stage has settled (a 2.5 s single stage)
    last = a
  }
  expect(steadyAmps(10, 120, edge)).toBeGreaterThanOrEqual(steadyAmps(600, 120, edge))
  expect(steadyAmps(150, 40, edge)).toBeCloseTo(steadyAmps(150, 120, edge) / 3, 9)
})

test('[BH-10] breakerFamily finds each of the five ids and nothing else', () => {
  for (const id of ['bussmann', 'optifuse', 'rev-ato', 'ctre-ato', 'snap-action']) expect(breakerFamily(id)?.id).toBe(id)
  expect(breakerFamily('atm')).toBeUndefined()
  expect(breakerFamily('')).toBeUndefined()
})
