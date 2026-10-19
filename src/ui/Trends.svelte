<!--
  Per-match trends as small multiples (Tufte): one small chart per number, the same match order on every chart and
  one scale per number across all matches. Each point is coloured by the battery used (logged, or typed by hand).
-->
<script lang="ts">
  import type { MatchSummary, MatchMetrics } from '../session/summary.ts'

  let { matches, typedBatteries }: { matches: MatchSummary[]; typedBatteries: Record<string, string> } = $props()

  const METRICS: { key: keyof MatchMetrics; label: string; unit: string; digits: number; line?: number }[] = [
    { key: 'minVolts', label: 'Lowest voltage', unit: 'V', digits: 2, line: 7 },
    { key: 'secondsUnder7', label: 'Time under 7 V', unit: 's', digits: 1 },
    { key: 'chargeAh', label: 'Charge drawn', unit: 'Ah', digits: 2 },
    { key: 'resistanceMilliohms', label: 'Battery + wiring', unit: 'mΩ', digits: 1, line: 20 },
    { key: 'followerSpeedPct', label: 'Slowest follower vs leader', unit: '%', digits: 0, line: 85 },
    { key: 'loopOverrunPct', label: 'Auto loops over 20 ms', unit: '%', digits: 1, line: 10 },
    { key: 'visionOutlierPct', label: 'Vision poses > 0.5 m off', unit: '%', digits: 1, line: 5 },
  ]
  // Five colours; batteries beyond five also get a letter on the point so none can be confused.
  const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)']
  const battery = (m: MatchSummary) => m.batteryId ?? typedBatteries[m.fileName] ?? ''
  const batteries = $derived([...new Set(matches.map(battery).filter(Boolean))])
  const colour = (m: MatchSummary) => (battery(m) ? COLORS[batteries.indexOf(battery(m)) % COLORS.length] : 'var(--muted)')

  const W = 220, H = 70, P = 6
  function points(key: keyof MatchMetrics, line?: number) {
    const vals = matches.map((m) => m.metrics[key])
    const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v))
    if (nums.length === 0) return null
    let lo = Math.min(...nums, line ?? Infinity), hi = Math.max(...nums, line ?? -Infinity)
    if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
    const x = (i: number) => P + (matches.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (matches.length - 1))
    const y = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)
    return { vals, x, y, lo, hi }
  }
</script>

<div class="multiples">
  {#each METRICS as metric (metric.key)}
    {@const p = points(metric.key, metric.line)}
    <figure>
      <figcaption>{metric.label} <span>({metric.unit})</span></figcaption>
      {#if p}
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric.label} per match`}>
          {#if metric.line !== undefined}<line class="ref" x1={P} x2={W - P} y1={p.y(metric.line)} y2={p.y(metric.line)} />{/if}
          {#each matches as m, i (m.fileName)}
            {@const v = p.vals[i]}
            {#if v !== null && Number.isFinite(v)}
              {#if batteries.length > COLORS.length && battery(m)}<text class="tag" x={p.x(i) + 4} y={p.y(v) - 4}>{batteries.indexOf(battery(m)) + 1}</text>{/if}
              <circle cx={p.x(i)} cy={p.y(v)} r="3.5" fill={colour(m)}><title>{m.matchLabel || m.fileName}: {v.toFixed(metric.digits)} {metric.unit}{battery(m) ? ` · battery ${battery(m)}` : ''}</title></circle>
            {/if}
          {/each}
        </svg>
        <div class="range">{p.lo.toFixed(metric.digits)}–{p.hi.toFixed(metric.digits)}</div>
      {:else}
        <p class="none">not in these logs</p>
      {/if}
    </figure>
  {/each}
</div>
{#if batteries.length}
  <p class="key">{#each batteries as b, i (b)}<span><span class="dot" style={`background:${COLORS[i % COLORS.length]}`}></span>{batteries.length > COLORS.length ? `${i + 1} ` : ''}{b}</span>{/each}<span><span class="dot" style="background:var(--muted)"></span>no battery ID</span></p>
{:else}
  <p class="key">No battery IDs yet: type them in the list below to colour the points by battery.</p>
{/if}

<style>
  .multiples { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: 0.75rem 1.25rem; }
  figure { margin: 0; }
  figcaption { font-size: 0.8rem; }
  figcaption span, .range, .none, .key { color: var(--muted); font-size: 0.75rem; }
  svg { width: 100%; height: auto; display: block; border-bottom: 1px solid var(--border); }
  .tag { font-size: 8px; fill: var(--muted); }
  .ref { stroke: var(--error); stroke-dasharray: 3 3; stroke-width: 1; opacity: 0.6; }
  .key { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
</style>
