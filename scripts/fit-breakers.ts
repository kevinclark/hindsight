/**
 * Refit each breaker edge's heating stages to its datasheet points (src/power/breaker-curves.json), at the stage
 * count the file already has (frozen: a refit can't land on another count). Prints each edge's error in current
 * (what a warning acts on) beside the recorded one, and exits 1 when an edge is worse than recorded + 0.5 points.
 *
 *   node --experimental-strip-types scripts/fit-breakers.ts [--write <out.json>] [<family id> ...]
 *
 * `--write` saves the whole table with the new taus, weights, tripRatio and fitError (points untouched) to the path
 * given; it never overwrites the committed JSON by itself. Not run in CI: it takes minutes (Nelder-Mead from nine
 * starts per edge). The numbers it finds need not match the committed ones bit for bit; only an error no worse.
 *
 * Model (src/power/breakers.ts): stage i has time constant taus[i], weight weights[i]; a constant current x (share of
 * rating) trips the edge when x² · Σ wᵢ(1 − exp(−t/τᵢ)) reaches tripRatio². Fit: log of trip time at each datasheet
 * point, least squares. Points at or below 100 % and over 20000 s are left out (the reference fitter's filter). The
 * Optifuse points already carry its published table at 135/200/300 % in place of chart points within 8 %.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import curves from '../src/power/breaker-curves.json' with { type: 'json' }

const TAU_MIN = 0.05
const TAU_MAX = 5000
/** Largest tripRatio allowed per edge: CTRE's slow edge is held to its 150 % must-trip bound. */
const RATIO_MAX: Record<string, number> = { 'ctre-ato slow': 1.5 }
const DEFAULT_RATIO_MAX = 9
/** How much worse than recorded an edge may fit (current error, as a share). */
const SLACK = 0.005

interface Model { taus: number[]; w: number[]; u: number }

/** Parameters p: log taus, log weight ratios (the last stage's is 1), tripRatio. */
function model(p: number[], n: number): Model {
  const taus = p.slice(0, n).map((v) => Math.min(TAU_MAX, Math.max(TAU_MIN, Math.exp(v))))
  const raw = [...p.slice(n, 2 * n - 1).map(Math.exp), 1]
  const sum = raw.reduce((a, b) => a + b, 0)
  return { taus, w: raw.map((v) => v / sum), u: p[2 * n - 1] }
}

function trip(x: number, m: Model): number {
  if (x <= m.u) return Infinity
  const th = (q: number) => x * x * m.taus.reduce((s, tau, i) => s + m.w[i] * (1 - Math.exp(-q / tau)), 0)
  let lo = 0
  let hi = 1e5
  if (th(hi) < m.u * m.u) return Infinity
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (th(mid) >= m.u * m.u) hi = mid
    else lo = mid
  }
  return hi
}

/** The current (share of rating) whose trip time is t. */
function currentAt(t: number, m: Model): number {
  let lo = m.u * 1.000001
  let hi = 50
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (trip(mid, m) > t) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function timeError(m: Model, pts: number[][]): { rms: number; max: number } {
  let s = 0
  let max = 0
  for (const [pc, t] of pts) {
    const mt = trip(pc / 100, m)
    const e = Number.isFinite(mt) && mt > 0 ? Math.log(mt / t) : 5
    s += e * e
    max = Math.max(max, Math.abs(e))
  }
  return { rms: Math.sqrt(s / pts.length), max }
}

function nelderMead(f: (p: number[]) => number, x0: number[], step: number, iterations: number): number[] {
  const n = x0.length
  let s = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const v = x0.slice()
    v[i] += step
    s.push(v)
  }
  let F = s.map(f)
  for (let k = 0; k < iterations; k++) {
    const idx = [...s.keys()].sort((a, b) => F[a] - F[b])
    s = idx.map((i) => s[i])
    F = idx.map((i) => F[i])
    const c = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += s[i][j] / n
    const worst = s[n]
    const r = c.map((v, j) => v + (v - worst[j]))
    const fr = f(r)
    if (fr < F[0]) {
      const e = c.map((v, j) => v + 2 * (v - worst[j]))
      const fe = f(e)
      if (fe < fr) { s[n] = e; F[n] = fe } else { s[n] = r; F[n] = fr }
    } else if (fr < F[n - 1]) {
      s[n] = r
      F[n] = fr
    } else {
      const ct = c.map((v, j) => v + 0.5 * (worst[j] - v))
      const fc = f(ct)
      if (fc < F[n]) { s[n] = ct; F[n] = fc } else {
        for (let i = 1; i <= n; i++) { s[i] = s[i].map((v, j) => s[0][j] + 0.5 * (v - s[0][j])); F[i] = f(s[i]) }
      }
    }
  }
  return s[0]
}

const TAU_STARTS: Record<number, number[][]> = { 1: [[1], [3], [5]], 2: [[0, 3], [1, 4.5], [2, 6]], 3: [[-1, 2, 5], [0, 3, 6], [1, 3.5, 7]] }
const WEIGHT_STARTS: Record<number, number[][]> = { 1: [[]], 2: [[-1], [0], [1]], 3: [[-1, -1], [0, 0], [1, -1], [-1, 1]] }

function fitEdge(n: number, pts: number[][], ratioMax: number): Model {
  const f = (p: number[]) => {
    const m = model(p, n)
    if (m.u < 1 || m.u > ratioMax) return 9
    if (m.taus.some((t) => t <= TAU_MIN || t >= TAU_MAX)) return 9
    return timeError(m, pts).rms
  }
  let best: { p: number[]; v: number } | null = null
  for (const ts of TAU_STARTS[n]) {
    for (const ws of WEIGHT_STARTS[n]) {
      for (const u of [1.0, 1.15, 1.3]) {
        if (u > ratioMax) continue
        const x0 = [...ts, ...ws, u]
        const p = nelderMead(f, x0, 0.6, 1500)
        const v = f(p)
        if (!best || v < best.v) best = { p, v }
      }
    }
  }
  return model(best!.p, n)
}

const round = (v: number, digits: number) => Number(v.toFixed(digits))

const args = process.argv.slice(2)
const w = args.indexOf('--write')
const out = w >= 0 ? args.splice(w, 2)[1] : null
if (w >= 0 && !out) throw new Error('--write needs a path')
const only = new Set(args)
const table = JSON.parse(readFileSync(new URL('../src/power/breaker-curves.json', import.meta.url), 'utf8')) as typeof curves
let worse = 0
for (const family of table.breakers) {
  if (only.size && !only.has(family.id)) continue
  for (const edgeName of ['fast', 'slow'] as const) {
    const edge = family.edges[edgeName]
    const pts = edge.points.filter(([p, t]) => p > 100 && t > 0 && t <= 20000)
    const n = edge.taus.length
    const m = fitEdge(n, pts, RATIO_MAX[`${family.id} ${edgeName}`] ?? DEFAULT_RATIO_MAX)
    const errs = pts.map(([pc, t]) => currentAt(t, m) / (pc / 100) - 1)
    const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length)
    const worst = Math.max(...errs.map(Math.abs))
    const te = timeError(m, pts)
    const ok = rms <= edge.fitError.currentRms + SLACK && worst <= edge.fitError.currentWorst + SLACK
    if (!ok) worse++
    console.log(
      `${family.id} ${edgeName} n=${n}  current rms ${(100 * rms).toFixed(1)} % (recorded ${(100 * edge.fitError.currentRms).toFixed(1)}), worst ${(100 * worst).toFixed(1)} % (recorded ${(100 * edge.fitError.currentWorst).toFixed(1)})  ${ok ? 'ok' : 'WORSE THAN RECORDED'}`,
    )
    edge.taus = m.taus.map((v) => round(v, 6))
    edge.weights = m.w.map((v) => round(v, 6))
    edge.tripRatio = round(m.u, 6)
    edge.fitError = { currentRms: round(rms, 4), currentWorst: round(worst, 4), timeRms: round(Math.exp(te.rms) - 1, 4), timeWorst: round(Math.exp(te.max) - 1, 4) }
  }
}
if (out) writeFileSync(out, JSON.stringify(table, null, 2) + '\n')
process.exit(worse ? 1 : 0)
