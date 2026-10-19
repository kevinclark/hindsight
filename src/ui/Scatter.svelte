<!-- A small labelled scatter plot (SVG): one point per sweep step, e.g. spin-up time against peak current. -->
<script lang="ts">
  let { points, xLabel, yLabel }: { points: { x: number; y: number; label: string; highlight?: boolean }[]; xLabel: string; yLabel: string } = $props()
  const W = 420, H = 200, P = { l: 46, r: 12, t: 12, b: 32 }
  const ok = $derived(points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
  const xs = $derived(ok.map((p) => p.x))
  const ys = $derived(ok.map((p) => p.y))
  const [x0, x1] = $derived(pad(Math.min(...xs), Math.max(...xs)))
  const [y0, y1] = $derived(pad(Math.min(...ys), Math.max(...ys)))
  function pad(lo: number, hi: number): [number, number] {
    if (!Number.isFinite(lo)) return [0, 1]
    const d = hi - lo || Math.abs(hi) || 1
    return [lo - 0.1 * d, hi + 0.1 * d]
  }
  const x = (v: number) => P.l + ((v - x0) / (x1 - x0)) * (W - P.l - P.r)
  const y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b)
</script>

<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yLabel} against ${xLabel}`}>
  <line class="axis" x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} />
  <line class="axis" x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} />
  <text class="tick" x={P.l} y={H - 8}>{x0.toFixed(0)}</text>
  <text class="tick" x={W - P.r} y={H - 8} text-anchor="end">{x1.toFixed(0)}</text>
  <text class="tick" x={(W + P.l) / 2} y={H - 8} text-anchor="middle">{xLabel}</text>
  <text class="tick" x={P.l - 6} y={P.t + 8} text-anchor="end">{y1.toFixed(2)}</text>
  <text class="tick" x={P.l - 6} y={H - P.b} text-anchor="end">{y0.toFixed(2)}</text>
  <text class="tick" x={4} y={(H - P.b + P.t) / 2}>{yLabel}</text>
  {#each ok as p (p.label)}
    <circle cx={x(p.x)} cy={y(p.y)} r={p.highlight ? 6 : 4} class:hl={p.highlight} />
    <text class="label" x={x(p.x) + 8} y={y(p.y) + 4}>{p.label}</text>
  {/each}
</svg>

<style>
  svg { width: 100%; max-width: 420px; height: auto; display: block; }
  .axis { stroke: var(--border); }
  .tick, .label { font-size: 11px; fill: var(--muted); }
  circle { fill: var(--series-1); }
  circle.hl { fill: var(--series-3); stroke: var(--fg); stroke-width: 1.5; }
</style>
