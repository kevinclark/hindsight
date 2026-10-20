<!--
  Limits tab (passive, any match log): each motor group's configured current limits against what the log shows,
  how much of the match it spends at its limit, a what-if for its supply limit, and the robot's current budget.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { CATCH_UP_SECONDS, limitsReport, OVER_MARGIN_A, type GroupLimits, type LimitView } from '../limits/limits-report.ts'
  import { groupWhatIf, robotBudget } from '../limits/budget.ts'
  import { zeroingChecks } from '../limits/zeroing.ts'
  import { powerReport } from '../power/power-report.ts'
  import { matchWhen } from '../match/match.ts'

  let { analysis }: { analysis: Analysis } = $props()
  const groups = $derived(limitsReport(analysis.match))
  const power = $derived(powerReport(analysis.match))
  const zeroing = $derived(zeroingChecks(analysis.match))

  // What-if: one group's supply cap per motor, replayed through the battery model.
  let whatIfGroup = $state('Flywheel')
  let whatIfCap = $state(40)
  const whatIf = $derived(groupWhatIf(analysis.match, whatIfGroup, whatIfCap))
  const budgetNow = $derived(robotBudget(analysis.match))
  const budgetWhatIf = $derived(robotBudget(analysis.match, { [whatIfGroup]: whatIfCap }))

  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')
  const VERDICT: Record<GroupLimits['verdict'], string> = {
    'limit-bound': 'limit-bound: at its limit 20 %+ of the time',
    'reaches the limit': 'reaches its limit sometimes',
    unconstrained: 'unconstrained: never near its limit',
    'no current logged': 'no current logged',
  }
  const capText = (g: GroupLimits) => (Number.isFinite(g.capPerMotorA) ? `${g.capPerMotorA} A per motor` : 'nothing: both limits switched off')
  const limitText = (l: LimitView) => (l.limitA === null ? 'not set' : `${l.limitA} A, ${l.on ? 'on' : 'OFF'}`)
</script>

<ul class="summary" aria-label="Summary of the groups below">
  {#each groups as g (g.group)}
    <li>
      <strong>{g.group}</strong>
      <span class={`chip ${g.verdict.replace(/ /g, '-')}`}>{VERDICT[g.verdict]}</span>
      <span class="cap" class:off={!Number.isFinite(g.capPerMotorA)}>Battery draw capped at {capText(g)}</span>
    </li>
  {/each}
</ul>

<details class="read">
  <summary>How to read this</summary>
  <p class="why">
    <strong>Stator</strong> current flows through the motor (torque, heat); <strong>supply</strong> current is what it
    draws from the battery. Supply ≈ stator × duty cycle, so supply can't exceed stator: with the supply limit off, the
    stator limit is what caps battery draw. Bursts over a limit of {CATCH_UP_SECONDS} s or less are the limiter catching
    up, not a limit that doesn't hold.
  </p>
</details>

{#each groups as g (g.group)}
  <section class="group">
    <h3>{g.group} <span class={`chip ${g.verdict.replace(/ /g, '-')}`}>{VERDICT[g.verdict]}</span></h3>
    <dl class="config">
      <div><dt>Supply limit</dt><dd class:off={g.supply.limitA !== null && !g.supply.on}>{limitText(g.supply)}</dd><dd class="note">{g.supply.note}</dd></div>
      <div><dt>Stator limit</dt><dd class:off={g.stator.limitA !== null && !g.stator.on}>{limitText(g.stator)}</dd><dd class="note">{g.stator.note}</dd></div>
      <div><dt>Battery draw capped at</dt><dd class:off={!Number.isFinite(g.capPerMotorA)}>{capText(g)}</dd><dd class="note">{g.motorCount} motors · at the limit {(100 * g.shareAtLimit).toFixed(1)} % of enabled time</dd></div>
      <div><dt>Set in</dt><dd><code>{g.where}</code></dd></div>
    </dl>
    {#each [g.supply, g.stator] as l (l.kind)}
      {#if l.motors.length}
        <table>
          <thead><tr><th>{l.kind} current</th><th>peak</th><th>p99</th><th>over {l.limitA ?? '—'}+{OVER_MARGIN_A} A</th><th>longest burst</th><th>in bursts &gt; {CATCH_UP_SECONDS} s</th><th>at the limit</th></tr></thead>
          <tbody>
            {#each l.motors as m (m.motor)}
              <tr>
                <th scope="row">{m.motor}</th><td>{m.peak.toFixed(0)} A</td><td>{m.p99.toFixed(0)} A</td><td>{f2(m.secondsOver)} s</td>
                <td class:bad={m.longestOver > CATCH_UP_SECONDS}>{f2(m.longestOver)} s</td>
                <td class:bad={m.secondsOverSustained > 0}>{f2(m.secondsOverSustained)} s</td><td>{f1(m.secondsAtLimit)} s</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/each}
  </section>
{/each}

<section class="group">
  <h3>What if: a supply limit on one group</h3>
  <p class="why">Replays this match through the battery model with that group's supply current capped per motor. The excess current is spent later (a slower spin-up), not dropped.</p>
  <div class="controls">
    <label>Group <select bind:value={whatIfGroup}>{#each groups as g (g.group)}<option value={g.group}>{g.group}</option>{/each}</select></label>
    <label>Cap per motor <input type="range" min="10" max="100" step="5" bind:value={whatIfCap} /> <strong>{whatIfCap} A</strong></label>
  </div>
  {#if whatIf && power?.fit && power.modelNoChange}
    <table>
      <thead><tr><th></th><th>lowest voltage</th><th>seconds under 7 V</th></tr></thead>
      <tbody>
        <tr><th scope="row">Logged</th><td>{f2(power.minVolts)} V</td><td>{f1(power.secondsUnder7)}</td></tr>
        <tr><th scope="row">Model, no change</th><td>{f2(power.modelNoChange.minVolts)} V</td><td>{f1(power.modelNoChange.secondsUnder7)}</td></tr>
        <tr class="hl"><th scope="row">Model, {whatIfGroup} at {whatIfCap} A</th><td>{f2(whatIf.minVolts)} V</td><td>{f1(whatIf.secondsUnder7)}</td></tr>
      </tbody>
    </table>
    <p class="note">Model error: ±{f2(power.fit.rmse)} V overall, ±{f2(power.fit.rmseLow)} V in sags below 7.5 V. A change smaller than that is not a reliable prediction.</p>
  {:else}
    <p class="note">The battery model can't be fitted on this log.</p>
  {/if}
</section>

<section class="group">
  <h3>Robot current budget</h3>
  {#if budgetNow}
    <p class="why">At the moment of most total current ({matchWhen(analysis.match, budgetNow.at)}), on the weakest battery in the fleet reference ({f2(budgetNow.weakestOcv)} V open-circuit) with this robot's {(budgetNow.resistanceOhms * 1000).toFixed(1)} mΩ. Goal: at least {budgetNow.floor} V (brownout + 1 V).</p>
    <table>
      <thead><tr><th>group</th><th>drawing then</th><th>allowed (limits now)</th>{#if budgetWhatIf}<th>allowed ({whatIfGroup} at {whatIfCap} A)</th>{/if}</tr></thead>
      <tbody>
        {#each budgetNow.rows as r, i (r.group)}
          <tr><th scope="row">{r.group}</th><td>{r.observedA.toFixed(0)} A</td><td>{r.capTotalA.toFixed(0)} A</td>{#if budgetWhatIf}<td>{budgetWhatIf.rows[i].capTotalA.toFixed(0)} A</td>{/if}</tr>
        {/each}
      </tbody>
    </table>
    <table>
      <thead><tr><th>add it up</th><th>limits now</th>{#if budgetWhatIf}<th>{whatIfGroup} at {whatIfCap} A</th>{/if}</tr></thead>
      <tbody>
        {#each budgetNow.scenarios as s, i (s.name)}
          <tr>
            <th scope="row">{s.name}</th>
            <td class:bad={s.volts < budgetNow.floor}>{s.amps.toFixed(0)} A → {f2(s.volts)} V</td>
            {#if budgetWhatIf}<td class:bad={budgetWhatIf.scenarios[i].volts < budgetNow.floor}>{budgetWhatIf.scenarios[i].amps.toFixed(0)} A → {f2(budgetWhatIf.scenarios[i].volts)} V</td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="note">Needs battery voltage and motor currents to compute.</p>
  {/if}
</section>

{#each zeroing as z (z.mechanism)}
  <section class="group">
    <h3>{z.mechanism}: hard-stop zeroing {#if z.thresholdAtLimit}<span class="chip limit-bound">threshold = stator limit</span>{/if}</h3>
    <p class="why">The zero drives the {z.mechanism.toLowerCase()} into its stop and calls it zeroed when current passes {z.thresholdA} A. Its stator limit is {z.statorLimitA} A{z.thresholdAtLimit ? ', so the current only gets there when the limiter overshoots' : ''}. Set in <code>{z.where}</code>.</p>
    {#if z.zeros.length}
      <table>
        <thead><tr><th>zero completed</th><th>peak current, 0.5 s before</th><th>time at or above {z.thresholdA} A</th></tr></thead>
        <tbody>{#each z.zeros as zero (zero.at)}<tr><td>{matchWhen(analysis.match, zero.at)}</td><td>{zero.peakA.toFixed(0)} A</td><td>{zero.secondsAtThreshold.toFixed(2)} s</td></tr>{/each}</tbody>
      </table>
    {:else}
      <p class="note">No current zero ran while enabled in this log.</p>
    {/if}
    {#if z.thresholdAtLimit}<p><strong>Suggestion:</strong> a threshold below the limit with margin, e.g. {z.suggestedThresholdA} A (70 % of {z.statorLimitA} A), so the zero doesn't depend on overshoot.</p>{/if}
  </section>
{/each}

<style>
  .summary { list-style: none; margin: 0.25rem 0 0.5rem; padding: 0; display: grid; gap: 0.15rem; font-size: 0.9rem; }
  .summary li { display: flex; flex-wrap: wrap; gap: 0 0.6rem; align-items: baseline; }
  .summary .cap { color: var(--muted); font-size: 0.85rem; }
  .summary .cap.off { color: var(--error); font-weight: 600; }
  .read { margin: 0.25rem 0; font-size: 0.85rem; }
  .read summary { cursor: pointer; color: var(--muted); }
  .why, .note { font-size: 0.85rem; color: var(--muted); max-width: 80ch; }
  .group { margin: 1.25rem 0; padding-top: 0.75rem; border-top: 1px solid var(--border); }
  h3 { font-size: 1rem; margin: 0 0 0.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
  .chip { font-size: 0.75rem; font-weight: normal; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .chip.limit-bound { border-color: var(--warning); color: var(--warning); }
  .config { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.5rem 1.25rem; margin: 0 0 0.75rem; }
  .config dt { font-size: 0.8rem; color: var(--muted); }
  .config dd { margin: 0; }
  .config dd.note { font-size: 0.75rem; color: var(--muted); }
  .off { color: var(--error); font-weight: 600; }
  table { border-collapse: collapse; font-size: 0.8rem; font-variant-numeric: tabular-nums; margin: 0.5rem 0; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: 0.15rem 0.9rem 0.15rem 0; white-space: nowrap; }
  thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  tbody th { font-weight: normal; }
  .bad { color: var(--error); font-weight: 600; }
  .hl { background: var(--hover); }
  .controls { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; align-items: center; font-size: 0.9rem; }
  input[type='range'] { width: 10rem; vertical-align: middle; }
</style>
