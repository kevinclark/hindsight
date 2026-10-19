<!-- The brownout view: margin, the loads at each sag, the battery's open-circuit voltage against charge, and what-ifs. -->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { powerReport, whatIfAt } from '../power/power-report.ts'
  import { buildPowerGrid, DT } from '../power/battery-model.ts'
  import { FLEET_REFERENCE } from '../power/fleet-reference.ts'
  import { downsample } from '../report/findings-json.ts'
  import Plot from './Plot.svelte'
  import type { PlotModel } from './plot-data.ts'

  let { analysis }: { analysis: Analysis } = $props()
  const m = $derived(analysis.match)
  const p = $derived(powerReport(m))
  const g = $derived(buildPowerGrid(m))

  let cap = $state(40)
  let mode = $state<'clip' | 'defer'>('defer')
  const whatIf = $derived(whatIfAt(m, cap, mode))

  const from = $derived((m.matchStart ?? m.logStart) - 2)
  const to = $derived((m.matchEnd ?? m.logEnd) + 2)

  function gridSeries(label: string, values: Float64Array): { label: string; t: number[]; v: number[] } {
    const grid = g!
    const i0 = Math.max(0, Math.floor((from - grid.t[0]) / DT))
    const i1 = Math.min(grid.t.length, Math.ceil((to - grid.t[0]) / DT))
    const d = downsample({ name: label, t: grid.t.subarray(i0, i1), v: values.subarray(i0, i1) }, 900)
    return { label, ...d }
  }

  const voltagePlot = $derived<PlotModel | null>(g && p ? {
    from, to, unit: 'V', series: [gridSeries('Battery voltage', g.volts)],
    threshold: Number.isFinite(p.brownoutVolts) ? { value: p.brownoutVolts, label: `brownout ${p.brownoutVolts} V` } : undefined,
    markers: p.sags.map((s) => ({ t: s.t, label: '' })),
  } : null)
  const currentPlot = $derived<PlotModel | null>(g ? {
    from, to, unit: 'A', series: [gridSeries('Total current (motors + other)', g.amps), ...g.groups.filter((x) => x.name === m.profile.whatIfGroup).map((x) => gridSeries(`${x.name}`, x.amps))],
  } : null)
  const ocvPlot = $derived<PlotModel | null>(p && p.ocv.length ? {
    from: 0, to: Math.max(p.ocv[p.ocv.length - 1].ah, FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah) + 0.25, unit: 'V',
    series: [
      { label: 'This battery (V + R·I)', t: p.ocv.map((x) => x.ah - 0.125), v: p.ocv.map((x) => x.volts) },
      { label: 'Healthy reference (CalGames Q13/Q21)', t: FLEET_REFERENCE.map((x) => x.ah - 0.25), v: FLEET_REFERENCE.map((x) => x.volts) },
    ],
  } : null)
  const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(2))
</script>

{#if !p || !g}
  <p>This log has no battery voltage or no motor supply currents, so the power view can't be drawn.</p>
{:else}
  <dl class="kpis">
    <div><dt>Lowest voltage (enabled)</dt><dd class:bad={p.marginVolts < 0} class:warn={p.marginVolts >= 0 && p.marginVolts < m.profile.power.marginVolts}>{f2(p.minVolts)} V</dd><dd class="sub">at {p.minAt.toFixed(1)} s</dd></div>
    <div><dt>Margin to brownout</dt><dd class:bad={p.marginVolts < 0} class:warn={p.marginVolts >= 0 && p.marginVolts < m.profile.power.marginVolts}>{f2(p.marginVolts)} V</dd><dd class="sub">setting {p.brownoutVolts} V; want ≥ {m.profile.power.marginVolts} V</dd></div>
    <div><dt>Time under 7 V</dt><dd>{p.secondsUnder7.toFixed(1)} s</dd><dd class="sub">while enabled</dd></div>
    <div><dt>Charge drawn</dt><dd>{p.chargeAh.toFixed(2)} Ah</dd><dd class="sub">motors + {m.profile.power.otherLoadsAmps} A other (assumed)</dd></div>
    <div><dt>Battery + wiring</dt><dd>{p.resistanceOhms ? (p.resistanceOhms * 1000).toFixed(1) : '—'} mΩ</dd><dd class="sub">from current steps</dd></div>
  </dl>

  <h3>Voltage and current over the match</h3>
  {#if voltagePlot}<Plot model={voltagePlot} height={150} />{/if}
  {#if currentPlot}<Plot model={currentPlot} height={130} />{/if}
  <p class="note">Total current is the sum of motor supply currents plus {m.profile.power.otherLoadsAmps} A for everything else. <code>/SystemStats/BatteryCurrent</code> is only the roboRIO's own draw (~0.5 A), so it isn't used.</p>

  <h3>The {p.sags.length} deepest sags, and what was drawing</h3>
  <table class="sags">
    <thead><tr><th>Time (s)</th><th>Voltage</th><th>Total</th><th>Top loads</th></tr></thead>
    <tbody>
      {#each p.sags as s (s.t)}
        <tr>
          <td>{s.t.toFixed(1)}</td><td>{s.volts.toFixed(2)} V</td><td>{s.totalAmps.toFixed(0)} A</td>
          <td>{s.loads.slice(0, 3).map((l) => `${l.group} ${l.amps.toFixed(0)} A`).join(' · ')}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h3>Battery: estimated open-circuit voltage against charge drawn</h3>
  {#if ocvPlot}<Plot model={ocvPlot} height={170} xLabel="Ah" />{/if}
  <p class="note">V + R·I with R = {p.resistanceOhms ? (p.resistanceOhms * 1000).toFixed(1) : '—'} mΩ, median per 0.25 Ah while enabled. A healthy battery stays high as charge is drawn; a weak one falls away. The reference is two batteries from one weekend until battery history exists.</p>

  <h3>What if the {p.whatIfGroup.toLowerCase()} were current-limited?</h3>
  {#if p.fit && p.modelNoChange}
    <p class="note">Replays this match's currents through a fitted battery model, V = V0 − k·Q − R0·I
      (V0 {p.fit.v0.toFixed(2)} V, k {p.fit.kVoltsPerAh.toFixed(2)} V/Ah, R0 {(p.fit.r0Ohms * 1000).toFixed(1)} mΩ).
      <strong>Model error: {p.fit.rmse.toFixed(2)} V overall, {f2(p.fit.rmseLow)} V in sags below 7.5 V.</strong>
      A what-if change smaller than the sag error is not a reliable prediction.</p>
    {#if Math.abs(p.modelNoChange.secondsUnder7 - p.secondsUnder7) > Math.max(2, 0.5 * p.secondsUnder7)}
      <p class="warn-box"><strong>The model misses this match's sags:</strong> it predicts {p.modelNoChange.secondsUnder7.toFixed(1)} s under 7 V where the log shows {p.secondsUnder7.toFixed(1)} s. Something it doesn't model (usually a battery losing capacity, see the curve above) drove the voltage down, so these what-ifs say little about this match.</p>
    {/if}
    <div class="slider">
      <label>Cap per motor: <input type="range" min="10" max="100" step="5" bind:value={cap} /> <strong>{cap} A</strong></label>
      <label><input type="radio" bind:group={mode} value="defer" /> slower spin-up (charge kept)</label>
      <label><input type="radio" bind:group={mode} value="clip" /> current dropped</label>
    </div>
    <table class="whatif">
      <thead><tr><th></th><th>Minimum voltage</th><th>Seconds under 7 V</th></tr></thead>
      <tbody>
        <tr><th scope="row">Logged</th><td>{f2(p.minVolts)} V</td><td>{p.secondsUnder7.toFixed(1)}</td></tr>
        <tr><th scope="row">Model, no change</th><td>{f2(p.modelNoChange.minVolts)} V</td><td>{p.modelNoChange.secondsUnder7.toFixed(1)}</td></tr>
        {#if whatIf}
          <tr class="hl"><th scope="row">Model, cap {cap} A ({mode === 'defer' ? 'slower spin-up' : 'dropped'})</th><td>{f2(whatIf.minVolts)} V</td><td>{whatIf.secondsUnder7.toFixed(1)}</td></tr>
        {/if}
        {#each p.whatIfs as w (w.capAmps + w.mode)}
          <tr><th scope="row">Model, cap {w.capAmps} A ({w.mode === 'defer' ? 'slower spin-up' : 'dropped'})</th><td>{f2(w.minVolts)} V</td><td>{w.secondsUnder7.toFixed(1)}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="note">Compare what-ifs with "Model, no change", not with "Logged": the model and the log disagree by the error above.</p>
  {:else}
    <p>Not enough enabled data to fit the battery model.</p>
  {/if}
{/if}

<style>
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem 1.5rem; margin: 0 0 1rem; }
  .kpis dt { color: var(--muted); font-size: 0.8rem; }
  .kpis dd { margin: 0; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
  .kpis dd.sub { font-size: 0.75rem; color: var(--muted); }
  .bad { color: var(--error); }
  .warn { color: var(--warning); }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .note { font-size: 0.85rem; color: var(--muted); max-width: 75ch; }
  table { border-collapse: collapse; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 0.2rem 1rem 0.2rem 0; vertical-align: top; }
  thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  tbody th { font-weight: normal; }
  .hl { background: var(--hover); }
  .warn-box { border-left: 3px solid var(--warning); padding: 0.25rem 0.75rem; font-size: 0.85rem; max-width: 75ch; }
  .slider { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center; margin: 0.5rem 0; font-size: 0.9rem; }
  input[type='range'] { vertical-align: middle; width: 10rem; }
</style>
