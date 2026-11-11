<!-- The brownout view: margin, sags as stretches under the margin line and the loads at each, the battery's open-circuit voltage against charge, and what-ifs. -->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { powerReport, whatIfAt } from '../power/power-report.ts'
  import { buildPowerGrid, DT } from '../power/battery-model.ts'
  import { bandText, buildDrag } from '../power/drag.ts'
  import { buildHeadroom, headroomMissing, headroomVerdicts } from '../power/headroom.ts'
  import { buildBreakdown, hasStates } from '../power/breakdown.ts'
  import { buildSagSpans, type Load } from '../power/sag-spans.ts'
  import { FLEET_REFERENCE } from '../power/fleet-reference.ts'
  import { downsample } from '../report/findings-json.ts'
  import Plot from './Plot.svelte'
  import { sagError, whatIfRow, whatIfRows } from '../power/whatif-rows.ts'
  import type { PlotModel } from './plot-data.ts'
  import { matchWhen } from '../match/match.ts'
  import BreakersStrip from './BreakersStrip.svelte'
  import { copyText } from './copy.ts'
  import { powerSummaryText } from '../power/summary-text.ts'

  let { analysis }: { analysis: Analysis } = $props()
  const m = $derived(analysis.match)
  const p = $derived(powerReport(m))
  const g = $derived(buildPowerGrid(m))
  const drag = $derived(buildDrag(m).filter((d) => d.bands.length))
  /** Motors with steady-speed bands, grouped by motor group in profile order, leader beside follower. */
  const dragGroups = $derived([...new Set(drag.map((d) => d.group))].map((group) => ({ group, motors: drag.filter((d) => d.group === group) })))

  /** Groups that ran at all: a never-enabled log has none, and the section says so instead of a table of blanks. */
  const headroom = $derived(buildHeadroom(m).filter((h) => h.runningSeconds > 0))
  const headroomWhyNot = $derived(headroomMissing(m))
  const verdicts = $derived(headroomVerdicts(headroom))
  const share = (x: number | null) => (x === null ? '—' : `${Math.round(100 * x)} %`)
  const ratio = (x: number) => `${Math.round(100 * x)} %`

  const sagSpans = $derived(buildSagSpans(m))
  const stretches = $derived(sagSpans?.mode === 'stretches')
  const lineText = $derived(sagSpans && Number.isFinite(sagSpans.line) ? `${+sagSpans.line.toFixed(2)}` : '')
  /** The biggest group with its current; the next two in a smaller line under it. */
  const top1 = (l: Load[] | null) => (l && l.length ? `${l[0].group} ${l[0].amps.toFixed(0)} A` : '—')
  /** "2:32 into the match" on one line, "(teleop; robot time 428.2 s)" small under it, so the column stays narrow on a phone. */
  const when = (t: number) => { const w = matchWhen(m, t); const i = w.indexOf(' ('); return i < 0 ? { head: w, tail: '' } : { head: w.slice(0, i), tail: w.slice(i + 1) } }
  const rest2 = (l: Load[] | null) => (l && l.length > 1 ? l.slice(1).map((x) => `${x.group} ${x.amps.toFixed(0)} A`).join(' · ') : '')

  const breakdown = $derived(buildBreakdown(m))
  const maxWh = $derived(Math.max(1e-9, ...(breakdown?.rows.map((r) => r.wh) ?? [0])))
  /** The groups whose state rows are open (collapsed by default). */
  let open = $state<string[]>([])
  const toggle = (name: string) => { open = open.includes(name) ? open.filter((x) => x !== name) : [...open, name] }
  const anyToggle = $derived(!!breakdown?.rows.some(hasStates))
  const wh1 = (x: number) => x.toFixed(1)
  const pct = (x: number, total: number) => (total > 0 ? `${((100 * x) / total).toFixed(0)} %` : '—')
  const a0 = (x: number | null) => (x === null ? '—' : x.toFixed(1))
  const spread = (r: { p50: number | null; p90: number | null; p99: number | null }) => (r.p50 === null ? '—' : `${a0(r.p50)} / ${a0(r.p90)} / ${a0(r.p99)}`)
  const secs = (x: number | null) => (x === null ? '—' : x.toFixed(1))

  let copied = $state<'' | 'yes' | 'no'>('')
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  async function copySummary() {
    const text = powerSummaryText(m)
    copied = text !== null && (await copyText(text)) ? 'yes' : 'no'
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied = ''), 3000)
  }

  let cap = $state(40)
  let mode = $state<'clip' | 'defer'>('defer')
  const whatIf = $derived(whatIfAt(m, cap, mode))
  const modelError = $derived(p?.fit ? sagError(p.fit) : null)
  const sliderRow = $derived(whatIf && p?.modelNoChange ? whatIfRow(p.modelNoChange, whatIf, `Model, cap ${cap} A (${mode === 'defer' ? 'slower spin-up' : 'dropped'})`, modelError) : null)
  const tableRows = $derived(p?.modelNoChange ? whatIfRows(p.modelNoChange, p.whatIfs.filter((w) => !(w.capAmps === cap && w.mode === mode)), modelError) : [])

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
    // Every stretch under the margin line shades as a span (not only the table's deepest 8); the lowest-points fallback keeps one marker per point.
    spans: stretches ? sagSpans!.allSpans.map((x) => ({ from: x.start, to: x.end })) : undefined,
    spanLabel: stretches ? `shaded: under ${lineText} V` : undefined,
    markers: stretches ? undefined : p.sags.map((s) => ({ t: s.t, label: '' })), matchStart: m.matchStart,
  } : null)
  const currentPlot = $derived<PlotModel | null>(g ? {
    from, to, unit: 'A', matchStart: m.matchStart, series: [gridSeries(g.currentFrom ? 'Total current (measured)' : 'Total current (motors + other)', g.amps), ...g.groups.filter((x) => x.name === m.profile.whatIfGroup).map((x) => gridSeries(`${x.name}`, x.amps))],
  } : null)
  const ocvPlot = $derived<PlotModel | null>(p && p.ocv.length ? {
    from: 0, to: Math.max(p.ocv[p.ocv.length - 1].ah, FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah) + 0.25, unit: 'V',
    series: [
      { label: 'This battery (V + R·I)', t: p.ocv.map((x) => x.ah - 0.125), v: p.ocv.map((x) => x.volts) },
      { label: 'Healthy reference (two 2026 matches)', t: FLEET_REFERENCE.map((x) => x.ah - 0.25), v: FLEET_REFERENCE.map((x) => x.volts) },
    ],
  } : null)
  const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(2))
</script>

<BreakersStrip profile={m.profile} map={m.powerMap} />

{#if !p || !g}
  <p>This log has no battery voltage or no motor supply currents, so the power view can't be drawn.</p>
{:else}
  <dl class="kpis">
    <div><dt>Lowest voltage (enabled)</dt><dd class:bad={p.marginVolts < 0} class:warn={p.marginVolts >= 0 && p.marginVolts < m.profile.power.marginVolts}>{f2(p.minVolts)} V</dd><dd class="sub">at {matchWhen(m, p.minAt)}</dd></div>
    <div><dt>Margin to brownout</dt><dd class:bad={p.marginVolts < 0} class:warn={p.marginVolts >= 0 && p.marginVolts < m.profile.power.marginVolts}>{f2(p.marginVolts)} V</dd><dd class="sub">setting {p.brownoutVolts} V; want ≥ {m.profile.power.marginVolts} V</dd></div>
    <div><dt>Time under 7 V</dt><dd>{p.secondsUnder7.toFixed(1)} s</dd><dd class="sub">while enabled</dd></div>
    <div><dt>Charge drawn</dt><dd>{p.chargeAh.toFixed(2)} Ah</dd><dd class="sub">{g?.currentFrom ? 'measured total' : `motors + ${m.profile.power.otherLoadsAmps} A other (assumed)`}</dd></div>
    <div><dt>Battery + wiring</dt><dd>{p.resistanceOhms ? (p.resistanceOhms * 1000).toFixed(1) : '—'} mΩ</dd><dd class="sub">from current steps</dd></div>
  </dl>
  <p class="copy">
    <button type="button" onclick={copySummary}>Copy summary</button>
    <span class="note" role="status" aria-live="polite">{#if copied === 'yes'}Copied: paste it into Slack.{:else if copied === 'no'}Couldn't copy: the browser would not allow it.{/if}</span>
  </p>

  {#if breakdown && breakdown.enabledSeconds === 0}
    <h3>Where the power went</h3>
    <p class="note">The robot was never enabled in this log, so there is no energy to split.</p>
  {:else if breakdown}
    <h3>Where the power went</h3>
    <table class="breakdown">
      <thead><tr><th>Group</th><th>Energy (Wh)</th><th>Share</th><th>Running (s)</th><th>P50 / P90 / P99 (A)</th><th>Peak (A)</th></tr></thead>
      <tbody>
        {#each breakdown.rows as r (r.name)}
          <tr class="grp">
            <th scope="row">
              {#if hasStates(r)}<button type="button" class="tog" aria-expanded={open.includes(r.name)} aria-label="States of {r.name}" onclick={() => toggle(r.name)}>{open.includes(r.name) ? '▾' : '▸'}</button>{:else}<span class="tog-gap"></span>{/if}{r.name}
            </th>
            <td class="wh"><span class="track"><span class="bar" aria-hidden="true" style:width="{(5 * r.wh) / maxWh}rem"></span></span><span class="num">{wh1(r.wh)}</span></td>
            <td>{pct(r.wh, breakdown.totalWh)}</td><td>{secs(r.runningSeconds)}</td><td>{spread(r)}</td><td>{a0(r.peak)}</td>
          </tr>
          {#if open.includes(r.name)}
            {#each r.states as s (s.name)}
              <tr class="state">
                <th scope="row" class="ind">{s.name}</th>
                <td class="wh"><span class="track"><span class="bar sub" aria-hidden="true" style:width="{(5 * s.wh) / maxWh}rem"></span></span><span class="num">{wh1(s.wh)}</span></td>
                <td>{pct(s.wh, breakdown.totalWh)}</td><td>{secs(s.runningSeconds)}</td><td>{spread(s)}</td><td>{a0(s.peak)}</td>
              </tr>
            {/each}
          {/if}
        {/each}
      </tbody>
    </table>
    <p class="note">Energy is supply current × battery voltage while enabled ({breakdown.enabledSeconds.toFixed(0)} s, {wh1(breakdown.totalWh)} Wh in all). A group's currents are its motors added together (Drive's P90 is all its motors at once, not one motor against a per-motor limit). Share is the share of the whole match's energy, state rows too. A group is running above {breakdown.runningAmps} A (an assumed line). {#if breakdown.measured}The whole-robot row is a measured total; the log has no motor currents.{:else}Everything not on a motor controller is {breakdown.otherLoadsAmps} A, assumed.{/if}
      {#if breakdown.stateNote}{breakdown.stateNote}{:else if anyToggle}Open a group to see the robot states it drew in; states with under 1 s of running are folded into "Other states".{/if}</p>
  {/if}

  <h3>Voltage and current over the match</h3>
  {#if voltagePlot}<Plot model={voltagePlot} height={150} />{/if}
  {#if currentPlot}<Plot model={currentPlot} height={130} />{/if}
  {#if g?.currentFrom}
    <p class="note">Total current is {g.currentFrom}.</p>
  {:else}
    <p class="note">Total current is the sum of motor supply currents plus {m.profile.power.otherLoadsAmps} A for everything else. <code>/SystemStats/BatteryCurrent</code> is only the roboRIO's own draw (~0.5 A), so it isn't used.</p>
  {/if}

  {#if sagSpans && stretches}
    <h3>{sagSpans.spans.length === 1 ? 'The deepest sag' : `The ${sagSpans.spans.length} deepest sags`} under {lineText} V, and what was drawing</h3>
    {#if sagSpans.totalSpans > sagSpans.spans.length}
      <p class="note">{sagSpans.totalSpans} stretches under {lineText} V, {sagSpans.secondsUnderLine.toFixed(1)} s under it in all; the {sagSpans.spans.length} deepest:</p>
    {/if}
    <table class="sags">
      <thead><tr><th>When</th><th>Length</th><th>Lowest</th><th>State</th><th>Total at lowest</th><th>At lowest</th><th>During</th><th>Before</th></tr></thead>
      <tbody>
        {#each sagSpans.spans as s (s.start)}
          <tr>
            <td class="moment">{when(s.start).head}<small>{when(s.start).tail}</small></td><td>{s.secondsUnder.toFixed(2)} s{#if s.seconds - s.secondsUnder >= 0.05 - 1e-9}<small>over {s.seconds.toFixed(2)} s</small>{/if}</td><td>{s.lowestVolts.toFixed(2)} V</td><td>{s.stateAtStart || '—'}</td>
            <td>{s.totalAmpsAtLowest.toFixed(0)} A</td><td>{top1(s.atLowest)}<small>{rest2(s.atLowest)}</small></td><td>{top1(s.during)}<small>{rest2(s.during)}</small></td><td>{top1(s.before)}<small>{rest2(s.before)}</small></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="note">A stretch is enabled time with the battery under {lineText} V (the brownout setting plus the {m.profile.power.marginVolts} V margin this robot wants), runs under 0.04 s dropped and runs within 0.25 s of each other joined. "During" is the mean over the stretch, "Before" the mean over the half second ahead of it; each shows the biggest motor group, then the next two.</p>
  {:else if sagSpans}
    <h3>The {sagSpans.spans.length} deepest sags, and what was drawing</h3>
    <p class="note">{sagSpans.reason}</p>
    <table class="sags">
      <thead><tr><th>When</th><th>Lowest</th><th>State</th><th>Total at lowest</th><th>At lowest</th><th>Before</th></tr></thead>
      <tbody>
        {#each sagSpans.spans as s (s.lowestAt)}
          <tr>
            <td class="moment">{when(s.lowestAt).head}<small>{when(s.lowestAt).tail}</small></td><td>{s.lowestVolts.toFixed(2)} V</td><td>{s.stateAtStart || '—'}</td>
            <td>{s.totalAmpsAtLowest.toFixed(0)} A</td><td>{top1(s.atLowest)}<small>{rest2(s.atLowest)}</small></td><td>{top1(s.before)}<small>{rest2(s.before)}</small></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if headroom.length}
    <h3>Headroom: how much more each mechanism had</h3>
    {#if verdicts.length}
      <ul class="says">
        {#each verdicts as v (v.group + v.kind)}
          <li><strong>{v.kind[0].toUpperCase() + v.kind.slice(1)}.</strong> {v.says} <span class="try">{v.tryThis}</span></li>
        {/each}
      </ul>
    {:else}
      <p class="note">Nothing ran at top speed with torque to spare, and no setpoint asked for more than the battery had.</p>
    {/if}
    <table class="headroom">
      <thead><tr><th>Group</th><th>Ran (s)</th><th>At stator limit</th><th>At supply cap</th><th>Share of top speed: typical / high</th><th>Within 10 % of top</th><th>Current there</th></tr></thead>
      <tbody>
        {#each headroom as h (h.group)}
          <tr>
            <th scope="row">{h.group}</th><td>{h.runningSeconds.toFixed(0)}</td><td>{share(h.atStator)}</td><td>{share(h.atSupply)}</td>
            <td>{h.topSpeed ? `${ratio(h.topSpeed.p50)} / ${ratio(h.topSpeed.p90)}` : '—'}</td><td>{h.topSpeed ? ratio(h.topSpeed.nearTop) : '—'}</td><td>{h.ampsNearTop === null || !h.topSpeed || h.topSpeed.nearTop < 0.01 ? '—' : `${Math.round(h.ampsNearTop)} A`}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#each headroom.filter((h) => h.setpoint && h.setpoint.seconds > 0) as h (h.group)}
      {@const sp = h.setpoint!}
      <p class="sp">{h.group} setpoint: needs {sp.needsVolts.toFixed(1)} V (median); held {sp.seconds.toFixed(0)} s; the battery was under that {ratio(sp.pastTop)} of it{#if sp.shortWhenPastTop !== null}, and the wheel was under 95 % of the setpoint {ratio(sp.shortWhenPastTop)} of that time{/if}{#if sp.shortOtherwise !== null}, {ratio(sp.shortOtherwise)} the rest{/if}.</p>
    {/each}
    <p class="note">Shares are of the time a motor ran: enabled, on CAN, drawing 5 A or driven with 1 V or more. A limit share is the time at 93 % of the limit or more; the supply cap is what the motor is held to after a second (its lower limit, Phoenix's 40 A if the code sets none). "—" in a limit column: no such limit, or the profile doesn't know it. Top speed is the speed the motor could reach on the battery voltage of that moment, from a fit of this log's applied volts against speed and current, so no gear ratio is needed; typical is the median, high the 90th percentile; "—" where the motor logs no speed or the fit can't be trusted. A setpoint counts once the wheel reached it or after 1.5 s at it. A mechanism told to run at full voltage sits near top speed by design. Verdicts need 30 s of running.</p>
  {:else if headroomWhyNot}
    <h3>Headroom: how much more each mechanism had</h3>
    <p class="note">{headroomWhyNot}</p>
  {/if}

  {#if dragGroups.length}
    <h3>Current at steady speed</h3>
    <table class="drag">
      <thead><tr><th>Motor</th><th>Speed band</th><th>Stator current</th><th>Steady seconds</th></tr></thead>
      <tbody>
        {#each dragGroups as dg (dg.group)}
          <tr class="group"><th colspan="4" scope="colgroup">{dg.group}</th></tr>
          {#each dg.motors as d (d.group + '/' + d.motor)}
            {#each d.bands as b, bi (b.band)}
              <tr>
                <td>{#if bi === 0}{d.motor}{/if}</td><td>{bandText(b.lo, b.hi, d.unit)}</td><td>{b.amps.toFixed(1)} A</td><td>{b.seconds.toFixed(1)} s</td>
              </tr>
            {/each}
          {/each}
        {/each}
      </tbody>
    </table>
    <p class="note">Median motor (stator) current while the motor is on CAN, the robot is enabled and the speed holds within 2 % over 0.2 s; speeds are grouped in bands 25 % wide, and a band needs 2 s. A mechanism that drags (a tight belt, a bent shaft) draws more at the same speed than it did in its own earlier matches: Session, Trends compares them. A motor off CAN or not turning leaves no row.</p>
  {/if}

  <h3>Battery: estimated open-circuit voltage against charge drawn</h3>
  {#if ocvPlot}<Plot model={ocvPlot} height={170} xLabel="Ah" />{/if}
  <p class="note">V + R·I with R = {p.resistanceOhms ? (p.resistanceOhms * 1000).toFixed(1) : '—'} mΩ, median per 0.25 Ah while enabled. A healthy battery stays high as charge is drawn; a weak one falls away. The reference is two batteries from one weekend until battery history exists.</p>

  {#if p.whatIfGroup}<h3>What if the {p.whatIfGroup.toLowerCase()} were current-limited?</h3>{/if}
  {#if p.whatIfGroup && p.fit && p.modelNoChange}
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
      <thead><tr><th></th><th>Minimum voltage</th><th>Seconds under 7 V</th><th></th></tr></thead>
      <tbody>
        <tr><th scope="row">Logged</th><td>{f2(p.minVolts)} V</td><td>{p.secondsUnder7.toFixed(1)}</td><td></td></tr>
        <tr><th scope="row">Model, no change</th><td>{f2(p.modelNoChange.minVolts)} V</td><td>{p.modelNoChange.secondsUnder7.toFixed(1)}</td><td></td></tr>
        {#if sliderRow}
          <tr class="hl" class:muted={sliderRow.withinError || sliderRow.sameAsNoChange}><th scope="row">{sliderRow.label}</th><td>{f2(sliderRow.minVolts)} V</td><td>{sliderRow.secondsUnder7.toFixed(1)}</td><td class="words">{sliderRow.words}</td></tr>
        {/if}
        {#each tableRows as w (w.label)}
          <tr class:muted={w.withinError || w.sameAsNoChange}><th scope="row">{w.label}</th><td>{f2(w.minVolts)} V</td><td>{w.secondsUnder7.toFixed(1)}</td><td class="words">{w.words}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="note">Compare what-ifs with "Model, no change", not with "Logged": the model and the log disagree by the error above. Rows in grey change the lowest voltage by less than the sag error ({modelError === null ? '—' : f2(modelError)} V) or are the same as no change.</p>
  {:else if p.whatIfGroup}
    <p>Not enough enabled data to fit the battery model.</p>
  {/if}
{/if}

<style>
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem 1.5rem; margin: 0 0 1rem; }
  .kpis dt { color: var(--muted); font-size: 0.8rem; }
  .kpis dd { margin: 0; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
  .kpis dd.sub { font-size: 0.75rem; color: var(--muted); }
  .bad { color: var(--error); }
  tr.muted th, tr.muted td { color: var(--muted); font-weight: normal; }
  td.words { font-size: 0.8rem; color: var(--muted); }
  .warn { color: var(--warning); }
  /* Controls at least 24 x 24 CSS px (WCAG 2.2 SC 2.5.8 Target Size, minimum). */
  .copy { display: flex; align-items: center; gap: 0.75rem; margin: 0 0 0.5rem; }
  .copy button { min-height: 24px; min-width: 24px; }
  .copy .note { margin: 0; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .note { font-size: 0.85rem; color: var(--muted); max-width: 75ch; }
  table { border-collapse: collapse; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  /* A wide table scrolls inside itself on a phone instead of widening the page (as LimitsTab does). */
  table.breakdown, table.sags, table.headroom { display: block; overflow-x: auto; max-width: 100%; }
  th, td { text-align: left; padding: 0.2rem 1rem 0.2rem 0; vertical-align: top; }
  thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  tbody th { font-weight: normal; }
  tr.group th { color: var(--muted); font-size: 0.75rem; padding-top: 0.5rem; }
  .sags td.moment { white-space: nowrap; }
  .sags td small { display: block; color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
  .hl { background: var(--hover); }
  .breakdown td, .breakdown th { white-space: nowrap; vertical-align: middle; }
  .breakdown td.wh { font-variant-numeric: tabular-nums; }
  .breakdown tr.grp th { font-weight: normal; }
  .breakdown th.ind { padding-left: 2rem; color: var(--muted); }
  .breakdown tr.state td { color: var(--muted); }
  /* A fixed-width track holds each bar, so every Wh number starts at the same x (Tufte: aligned columns compare). */
  .track { display: inline-block; width: 5rem; margin-right: 0.5rem; vertical-align: middle; }
  .bar { display: inline-block; height: 0.6rem; background: var(--series-1, var(--focus)); vertical-align: middle; }
  .bar.sub { opacity: 0.6; }
  /* Controls at least 24 x 24 CSS px (WCAG 2.2 SC 2.5.8 Target Size, minimum). */
  .tog { min-width: 24px; min-height: 24px; padding: 0; margin: 0 0.25rem 0 0; border: 0; background: none; color: inherit; cursor: pointer; font: inherit; }
  .tog-gap { display: inline-block; width: 24px; margin-right: 0.25rem; }
  .says { padding-left: 1.25rem; max-width: 75ch; font-size: 0.9rem; }
  .says li { margin: 0 0 0.4rem; }
  .says .try { color: var(--muted); }
  .headroom td, .headroom th { white-space: nowrap; }
  p.sp { font-size: 0.85rem; max-width: 75ch; margin: 0.5rem 0 0; }
  .warn-box { border-left: 3px solid var(--warning); padding: 0.25rem 0.75rem; font-size: 0.85rem; max-width: 75ch; }
  .slider { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center; margin: 0.5rem 0; font-size: 0.9rem; }
  .slider label { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 24px; }
  /* Controls at least 24 x 24 CSS px (WCAG 2.2 SC 2.5.8 Target Size, minimum). */
  input[type='range'] { vertical-align: middle; width: 10rem; height: 24px; margin: 0; }
  input[type='radio'] { width: 24px; height: 24px; margin: 0; }
</style>
