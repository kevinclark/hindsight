<!-- The lint report for one match: findings worst first, then what couldn't be checked. -->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import FindingRow from './FindingRow.svelte'
  import { ruleById } from '../rules/index.ts'
  import type { Audience } from '../rules/types.ts'

  let { analysis }: { analysis: Analysis } = $props()
  // Who is reading: the software team, the pit crew or the drive team see the findings they can act on.
  const AUDIENCES: { id: Audience | 'all'; label: string }[] = [
    { id: 'all', label: 'Everyone' }, { id: 'software', label: 'Software' }, { id: 'pit', label: 'Pit crew' }, { id: 'drive', label: 'Drive team' },
  ]
  let audience = $state<Audience | 'all'>(readSavedAudience())
  const all = $derived(analysis.report.findings.filter((f) => f.rule !== 'meta/not-checked'))
  const forAudience = (id: Audience | 'all') => all.filter((f) => id === 'all' || (ruleById(f.rule)?.audience ?? []).includes(id))
  const findings = $derived(forAudience(audience))
  const count = (s: string) => findings.filter((f) => f.severity === s).length

  function readSavedAudience(): Audience | 'all' {
    try { return (localStorage.getItem('hindsight.audience') as Audience | 'all') || 'all' } catch { return 'all' }
  }
  function choose(id: Audience | 'all') {
    audience = id
    try { localStorage.setItem('hindsight.audience', id) } catch { /* private window: just don't remember */ }
  }
</script>

<div class="audience" role="radiogroup" aria-label="Show findings for">
  {#each AUDIENCES as a (a.id)}
    {@const errors = forAudience(a.id).filter((f) => f.severity === 'error').length}
    <button role="radio" aria-checked={audience === a.id} class:active={audience === a.id} onclick={() => choose(a.id)}>
      {a.label} <span class="n">{forAudience(a.id).length}{#if errors}{' · '}<span class="e">{errors} red</span>{/if}</span>
    </button>
  {/each}
</div>

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
  <p>No findings{audience === 'all' ? '' : ' for this group'}. Every rule not listed under "Not checked" looked and found nothing.</p>
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
  .audience { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.75rem; }
  .audience button { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
  .audience button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .audience .n { color: var(--muted); }
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
