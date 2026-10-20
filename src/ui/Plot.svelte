<!--
  A small time plot drawn as SVG. Lines are drawn as steps (hold-last), never as slopes between records,
  because a logged value holds until the next record. Minimal axes (Tufte: data ink first).
-->
<script lang="ts">
  import type { PlotModel } from './plot-data.ts'
  import { clock } from '../match/match.ts'

  // `compact`: sparkline height for the printed report (2 y-ticks, no x-ticks, tight padding; the unit and time range
  // go in the caption instead of the plot's margins).
  let { model, height = 140, xLabel = 's', compact = false }: { model: PlotModel; height?: number; xLabel?: string; compact?: boolean } = $props()

  const W = $derived(compact ? 330 : 640) // compact is drawn about 3.1 in wide in print, so the text stays 11 px there
  const PAD = $derived(compact ? { left: 44, right: 10, top: 4, bottom: 10 } : { left: 44, right: 10, top: 18, bottom: 22 })
  const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']

  const yRange = $derived.by(() => {
    let lo = Infinity, hi = -Infinity
    for (const s of model.series) for (const v of s.v) { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
    if (model.threshold) { lo = Math.min(lo, model.threshold.value); hi = Math.max(hi, model.threshold.value) }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
    const pad = (hi - lo) * 0.08
    return { lo: lo - pad, hi: hi + pad }
  })

  const x = (t: number) => PAD.left + ((t - model.from) / (model.to - model.from)) * (W - PAD.left - PAD.right)
  const y = (v: number) => PAD.top + (1 - (v - yRange.lo) / (yRange.hi - yRange.lo)) * (height - PAD.top - PAD.bottom)

  function stepPath(t: number[], v: number[]): string {
    let d = ''
    for (let i = 0; i < t.length; i++) {
      if (!Number.isFinite(v[i])) continue
      const px = x(Math.max(model.from, Math.min(model.to, t[i]))).toFixed(1)
      const py = y(v[i]).toFixed(1)
      if (d === '') d = `M${px},${py}`
      else d += `H${px}V${py}`
    }
    if (d && t.length) d += `H${x(model.to).toFixed(1)}`
    return d
  }

  // Tick values and how many decimals they need, from the step between them (2.0, 4.0 → "2", "4"; 0.5 → "0.5").
  function ticks(lo: number, hi: number, count: number): { values: number[]; digits: number } {
    const step0 = (hi - lo) / count
    const mag = 10 ** Math.floor(Math.log10(step0))
    // The 1-2-5 step closest to the ideal (in ratio), so a range just over 4 steps still gets 4–5 ticks.
    const step = [1, 2, 5, 10].map((m) => m * mag).reduce((best, s) => (Math.abs(Math.log(s / step0)) < Math.abs(Math.log(best / step0)) ? s : best))
    const values: number[] = []
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) values.push(+v.toFixed(6))
    return { values, digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) }
  }
  // Compact: two labelled ticks at most (the lowest and highest the 1-2-5 steps give), never a lone one.
  function compactTicks(lo: number, hi: number): { values: number[]; digits: number } {
    for (const count of [2, 3, 4, 6]) {
      const t = ticks(lo, hi, count)
      if (t.values.length >= 2) return { values: [t.values[0], t.values[t.values.length - 1]], digits: t.digits }
    }
    return ticks(lo, hi, 2)
  }
  const yTicks = $derived(compact ? compactTicks(yRange.lo, yRange.hi) : ticks(yRange.lo, yRange.hi, 4))
  // The time axis reads in match time (what people think in) when the match start is known; robot time otherwise.
  const ms = $derived(xLabel === 's' && model.matchStart != null ? model.matchStart : null)
  const xTicks = $derived(ms === null ? ticks(model.from, model.to, 6) : ticks(model.from - ms, model.to - ms, 6))
  const tickAt = (v: number) => (ms === null ? v : v + ms)
  // Ticks closer than a second apart (a short window) read in seconds; m:ss would repeat "0:01, 0:01".
  const tickText = (v: number) => (ms === null || xTicks.digits > 0 ? v.toFixed(xTicks.digits) : v < 0 ? `−${clock(-v)}` : clock(v))
  const axisText = $derived(ms === null ? xLabel : `${xTicks.digits > 0 ? 'seconds into the match' : 'match time'} (robot time ${model.from.toFixed(0)}–${model.to.toFixed(0)} s)`)
</script>

<figure class="plot">
  <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={model.series.map((s) => s.label).join(', ')}>
    {#each yTicks.values as v (v)}
      <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
      <text class="tick" x={PAD.left - 6} y={y(v) + 4} text-anchor="end">{v.toFixed(yTicks.digits)}</text>
    {/each}
    {#if !compact}
      {#each xTicks.values as t (t)}
        <text class="tick" x={x(tickAt(t))} y={height - 6} text-anchor="middle">{tickText(t)}</text>
      {/each}
      <text class="tick unit" x={4} y={11}>{model.unit}</text>
      <text class="tick unit" x={W - PAD.right} y={11} text-anchor="end">{axisText}</text>
    {/if}
    {#if model.threshold}
      <line class="threshold" x1={PAD.left} x2={W - PAD.right} y1={y(model.threshold.value)} y2={y(model.threshold.value)} />
    {/if}
    {#each model.markers ?? [] as m, i (i)}
      {#if m.t >= model.from && m.t <= model.to}
        <line class="marker" x1={x(m.t)} x2={x(m.t)} y1={PAD.top} y2={height - PAD.bottom} />
      {/if}
    {/each}
    {#each model.series as s, i (s.label)}
      <path d={stepPath(s.t, s.v)} stroke={COLORS[i % COLORS.length]} />
    {/each}
  </svg>
  {#if compact || model.series.length > 1 || model.threshold}
    <figcaption>
      {#if compact}<span class="key">{model.unit ? `${model.unit} · ` : ''}{axisText}</span>{/if}
      {#each model.series as s, i (s.label)}
        <span class="key"><span class="swatch" style={`background:${COLORS[i % COLORS.length]}`}></span>{s.label}</span>
      {/each}
      {#if model.threshold}
        <span class="key threshold-key"><span class="swatch dashed"></span>{model.threshold.label}</span>
      {/if}
    </figcaption>
  {/if}
</figure>

<style>
  .plot { margin: 0.5rem 0 0; }
  svg { width: 100%; height: auto; display: block; overflow: visible; }
  path { fill: none; stroke-width: 1.4; vector-effect: non-scaling-stroke; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .threshold { stroke: var(--error); stroke-dasharray: 4 3; stroke-width: 1; }
  .marker { stroke: var(--muted); stroke-width: 1; opacity: 0.25; }
  figcaption { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.8rem; color: var(--muted); padding-left: 44px; }
  .swatch { display: inline-block; width: 10px; height: 3px; margin-right: 5px; vertical-align: middle; }
  .swatch.dashed { height: 0; border-top: 2px dashed var(--error); }
</style>
