<!-- One finding: severity, title and time; opens to evidence, a plot of the moment, the fix and the incident. -->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import type { Finding } from '../rules/types.ts'
  import { ruleById } from '../rules/index.ts'
  import Plot from './Plot.svelte'
  import { plotModel } from './plot-data.ts'

  let { finding, analysis }: { finding: Finding; analysis: Analysis } = $props()
  const rule = $derived(ruleById(finding.rule))
  const LABEL = { error: 'Error', warning: 'Warning', info: 'Info' } as const
  const ICON = { error: '●', warning: '▲', info: '○' } as const
  // Errors start open; the reader can open or close any row after that.
  // svelte-ignore state_referenced_locally
  let open = $state(finding.severity === 'error')
</script>

<li class={`finding ${finding.severity}`}>
  <details bind:open>
    <summary>
      <span class="sev" title={LABEL[finding.severity]}><span aria-hidden="true">{ICON[finding.severity]}</span> {LABEL[finding.severity]}</span>
      <span class="title">{finding.title}</span>
      <span class="rule">{finding.rule}</span>
    </summary>
    <div class="body">
      <table class="evidence">
        <tbody>
          {#each Object.entries(finding.evidence) as [k, v] (k)}
            <tr><th scope="row">{k}</th><td>{v}</td></tr>
          {/each}
        </tbody>
      </table>
      {#if finding.plot && open}
        <Plot model={plotModel(analysis.match, finding.plot)} />
      {/if}
      {#if rule}
        <p class="fix"><strong>What to do:</strong> {rule.fix}</p>
        <p class="incident"><strong>Why this rule exists:</strong> {rule.incident}</p>
      {/if}
    </div>
  </details>
</li>

<style>
  .finding { border-bottom: 1px solid var(--border); list-style: none; }
  summary { display: grid; grid-template-columns: 6.5rem 1fr auto; gap: 0.75rem; align-items: baseline; padding: 0.55rem 0.25rem; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--hover); }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .sev { font-weight: 600; font-size: 0.85rem; white-space: nowrap; }
  .error .sev { color: var(--error); }
  .warning .sev { color: var(--warning); }
  .info .sev { color: var(--muted); }
  .title { min-width: 0; overflow-wrap: anywhere; }
  .rule { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
  .body { padding: 0 0.25rem 0.9rem 7.25rem; }
  .evidence { border-collapse: collapse; font-size: 0.85rem; }
  .evidence th { text-align: left; font-weight: normal; color: var(--muted); padding: 0.1rem 1rem 0.1rem 0; vertical-align: top; }
  .evidence td { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .fix, .incident { font-size: 0.85rem; margin: 0.5rem 0 0; max-width: 70ch; }
  .incident { color: var(--muted); }
  @media (max-width: 640px) {
    summary { grid-template-columns: 1fr; gap: 0.15rem; }
    .body { padding-left: 0.25rem; }
  }
</style>
