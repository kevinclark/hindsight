<!-- The lint report for one match: findings worst first, then what couldn't be checked. -->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import FindingRow from './FindingRow.svelte'

  let { analysis }: { analysis: Analysis } = $props()
  const findings = $derived(analysis.report.findings.filter((f) => f.rule !== 'meta/not-checked'))
  const count = (s: string) => findings.filter((f) => f.severity === s).length
</script>

<p class="counts">
  <span class="e">{count('error')} errors</span> · <span class="w">{count('warning')} warnings</span> · {count('info')} info ·
  {analysis.report.skipped.length} rules not checked
</p>

{#if analysis.report.crashed.length}
  <div class="crashed" role="alert">
    <strong>Some rules crashed (a bug in Hindsight, not your robot):</strong>
    <ul>{#each analysis.report.crashed as c (c.rule)}<li><code>{c.rule}</code>: {c.reason}</li>{/each}</ul>
  </div>
{/if}

{#if findings.length === 0}
  <p>No findings. Every rule below "Not checked" looked and found nothing.</p>
{:else}
  <ul class="findings">
    {#each findings as f, i (f.rule + i)}
      <FindingRow finding={f} {analysis} />
    {/each}
  </ul>
{/if}

<section class="not-checked">
  <h3>Not checked</h3>
  {#if analysis.report.skipped.length === 0}
    <p>Every rule ran.</p>
  {:else}
    <p class="hint">These rules couldn't run on this log, so silence from them means nothing.</p>
    <table>
      <tbody>
        {#each analysis.report.skipped as s (s.rule)}
          <tr><th scope="row"><code>{s.rule}</code></th><td>{s.reason}</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .counts { color: var(--muted); margin: 0 0 0.5rem; }
  .e { color: var(--error); font-weight: 600; }
  .w { color: var(--warning); font-weight: 600; }
  .findings { padding: 0; margin: 0; border-top: 1px solid var(--border); }
  .not-checked { margin-top: 1.5rem; }
  h3 { font-size: 1rem; margin: 0 0 0.25rem; }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.5rem; }
  table { border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; font-weight: normal; padding: 0.15rem 1rem 0.15rem 0; vertical-align: top; white-space: nowrap; }
  td { color: var(--muted); overflow-wrap: anywhere; }
  .crashed { border: 1px solid var(--error); padding: 0.5rem 0.75rem; margin-bottom: 1rem; }
  @media (max-width: 640px) { th { white-space: normal; } }
</style>
