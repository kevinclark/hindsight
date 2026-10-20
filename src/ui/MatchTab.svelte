<!--
  The lint report for one match: new findings worst first (anything that came back after a fix at the top), then
  known issues, then tracked issues that didn't show up, then what couldn't be checked. A finding that another one
  explains is listed under it, collapsed (report/finding-tree.ts); the counts still count it.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import FindingRow from './FindingRow.svelte'
  import { makerOf } from '../rules/index.ts'
  import type { Audience, Finding } from '../rules/types.ts'
  import type { IssueEvent, IssueStatus } from '../triage/history.ts'
  import { findingStatus, playedAt } from '../report/review-model.ts'
  import { nest, partitionStanding, withParents } from '../report/finding-tree.ts'
  import { cardTitle } from '../report/titles.ts'

  let { analysis, issues, standing = new Set<string>(), onMark }: {
    analysis: Analysis
    issues: Map<string, IssueEvent>
    /** Issue keys that fired in every match of this match's session (session.ts standingKeys); empty when no loaded session holds it. */
    standing?: Set<string>
    onMark: (finding: Finding, status: IssueStatus, note: string) => void
  } = $props()

  // Who is reading: the software team, the pit crew or the drive team see the findings they can act on.
  const AUDIENCES: { id: Audience | 'all'; label: string }[] = [
    { id: 'all', label: 'Everyone' }, { id: 'software', label: 'Software' }, { id: 'pit', label: 'Pit crew' }, { id: 'drive', label: 'Drive team' },
  ]
  let audience = $state<Audience | 'all'>(readSavedAudience())
  const all = $derived(analysis.report.findings.filter((f) => f.rule !== 'meta/not-checked'))
  // Parents name a group of findings (src/rules/parents.ts): listed with them, never counted.
  const parents = $derived(analysis.report.parents ?? [])
  const withGroups = $derived([...all, ...parents])
  const isFor = (id: Audience | 'all') => (f: Finding) => id === 'all' || (makerOf(f.rule)?.who ?? []).includes(id)
  const forAudience = (id: Audience | 'all') => all.filter(isFor(id))
  const shown = $derived(forAudience(audience))
  const shownParents = $derived(parents.filter(isFor(audience)))
  // When this match was played (wall clock, ms), so a fix recorded after it doesn't make it "came back".
  const played = $derived(playedAt(analysis))
  const status = (f: Finding) => findingStatus(f, issues, played)
  const cameBack = $derived(shown.filter((f) => status(f) === 'came back'))
  const fresh = $derived(shown.filter((f) => !status(f)))
  const known = $derived(shown.filter((f) => status(f) === 'known' || status(f) === 'fixed later'))
  const active = $derived([...cameBack, ...fresh])
  // Every known issue, whichever audience is picked, so a hidden one still reads "explained by a known issue".
  const allKnown = $derived(withGroups.filter((f) => status(f) === 'known' || status(f) === 'fixed later'))
  const activeParents = $derived(shownParents.filter((f) => !status(f) || status(f) === 'came back'))
  const knownParents = $derived(shownParents.filter((f) => status(f) === 'known' || status(f) === 'fixed later'))
  const fullTree = $derived(nest(withParents(active, activeParents), withGroups, allKnown, cameBack))
  // A top-level finding folds into a closed group, with what it explains, only when it and everything under it fires in
  // every match of the session and none came back (partitionStanding). Anything else stays in the list.
  const partition = $derived(partitionStanding(fullTree, standing, cameBack, parents))
  const activeTree = $derived(partition.listed)
  const standingTree = $derived(partition.folded)
  // New errors first, then the fold, then new warnings and info, so the fold's summary (which names a standing error)
  // sits near the top: after the info rows it was off-screen at 1366×768 in 8 of 8 session-opened CalGames matches.
  const mainTree = $derived(activeTree.filter((n) => n.finding.severity === 'error'))
  const infoTree = $derived(activeTree.filter((n) => n.finding.severity !== 'error'))
  const standingErrors = $derived(standingTree.filter((n) => n.finding.severity === 'error').map((n) => n.finding))
  const standingWarnings = $derived(standingTree.filter((n) => n.finding.severity === 'warning').length)
  // The first active error's closed row carries its next step; derived, so it moves when that error is marked known or the audience changes.
  // It is the first error not in the fold; when every error is folded it falls back to the first folded one, whose next
  // step is then shown in the fold's summary (the rows inside a closed fold can't show it).
  const firstError = $derived(activeTree.find((n) => n.finding.severity === 'error' && !issues.get(n.finding.key))?.finding)
  const fallbackError = $derived(!firstError && standingTree.length ? standingTree.find((n) => n.finding.severity === 'error')?.finding : undefined)
  const knownTree = $derived(nest(withParents(known, knownParents), withGroups))
  const firing = $derived(new Set(withGroups.map((f) => f.key)))
  const quiet = $derived([...issues.values()].filter((e) => !firing.has(e.key)))
  // A rule that couldn't run says nothing about whether an issue is gone.
  const notRun = $derived(new Set(analysis.report.skipped.map((s) => s.rule)))
  const ruleOf = (key: string) => key.split(' · ')[0]
  const count = (s: string) => active.filter((f) => f.severity === s).length
  const red = (id: Audience | 'all') => forAudience(id).filter((f) => f.severity === 'error' && (!status(f) || status(f) === 'came back')).length

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
    {@const errors = red(a.id)}
    <button role="radio" aria-checked={audience === a.id} class:active={audience === a.id} onclick={() => choose(a.id)}>
      {a.label} <span class="n">{forAudience(a.id).length}{#if errors}{' · '}<span class="e">{errors} red</span>{/if}</span>
    </button>
  {/each}
</div>

<p class="counts">
  <span class="e">{count('error')} errors</span> · <span class="w">{count('warning')} warnings</span> · {count('info')} info ·
  {known.length} known · {analysis.report.skipped.length} rules not checked
</p>

{#if analysis.report.crashed.length}
  <div class="crashed" role="alert">
    <strong>Some rules crashed (a bug in Hindsight, not your robot):</strong>
    <ul>{#each analysis.report.crashed as c (c.rule)}<li><code>{c.rule}</code>: {c.reason}</li>{/each}</ul>
  </div>
{/if}

{#if active.length === 0}
  <p>No new findings{audience === 'all' ? '' : ' for this group'}. Every rule not listed under "Not checked" looked and found nothing new.</p>
{:else if mainTree.length}
  <ul class="findings">
    {#each mainTree as n (n.finding.key + n.finding.time)}
      <FindingRow finding={n.finding} explains={n.children} note={n.note} {analysis} issue={issues.get(n.finding.key)} {issues} statusOf={status} showNext={n.finding === firstError} {onMark} />
    {/each}
  </ul>
{/if}

{#if standingTree.length}
  <details class="standing">
    <summary>
      <h3>In every match of this session ({standingTree.length})</h3>
      <span class="sum">
        {#if standingErrors.length}<span class="e">{standingErrors.length} error{standingErrors.length === 1 ? '' : 's'}</span>: {standingErrors.map((f) => cardTitle(f.title)).join('; ')}{#if standingWarnings}{', '}{/if}{/if}{#if standingWarnings}<span class="w">{standingWarnings} warning{standingWarnings === 1 ? '' : 's'}</span>{/if}
      </span>
      {#if fallbackError}<span class="sum next"><strong>Next step:</strong> {fallbackError.nextStep}</span>{/if}
    </summary>
    <ul class="findings">
      {#each standingTree as n (n.finding.key + n.finding.time)}
        <FindingRow finding={n.finding} explains={n.children} note={n.note} {analysis} issue={issues.get(n.finding.key)} {issues} statusOf={status} {onMark} />
      {/each}
    </ul>
  </details>
{/if}

{#if infoTree.length}
  <ul class="findings">
    {#each infoTree as n (n.finding.key + n.finding.time)}
      <FindingRow finding={n.finding} explains={n.children} note={n.note} {analysis} issue={issues.get(n.finding.key)} {issues} statusOf={status} showNext={n.finding === firstError} {onMark} />
    {/each}
  </ul>
{/if}

{#if known.length}
  <details class="known-section">
    <summary><h3>Known issues seen this match ({known.length})</h3></summary>
    <ul class="findings">
      {#each knownTree as n (n.finding.key + n.finding.time)}
        <FindingRow finding={n.finding} explains={n.children} note={n.note} {analysis} issue={issues.get(n.finding.key)} fixedLater={status(n.finding) === 'fixed later'} {issues} statusOf={status} {onMark} />
      {/each}
    </ul>
  </details>
{/if}

{#if quiet.length}
  <section class="quiet">
    <h3>Tracked issues not seen this match</h3>
    <ul>
      {#each quiet as e (e.key)}
        <li><code>{e.key}</code>: {e.status === 'fixed' ? 'fixed' : 'known'} on {e.when.slice(0, 10)}{e.note ? ` (${e.note})` : ''}{notRun.has(ruleOf(e.key)) ? '; the rule could not run on this log, so this says nothing' : e.status === 'fixed' ? '; quiet this match ✓' : '; not seen this match'}</li>
      {/each}
    </ul>
  </section>
{/if}

<section class="not-checked">
  <h3>Not checked</h3>
  {#if analysis.report.skipped.length === 0}
    <p>Every rule ran.</p>
  {:else}
    <p class="hint">These rules couldn't run (or only partly) on this log, so silence from them means nothing.</p>
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
  .counts { color: var(--muted); margin: 0 0 0.35rem; }
  .e { color: var(--error); font-weight: 600; }
  .w { color: var(--warning); font-weight: 600; }
  .audience { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.5rem; }
  .audience button { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 999px; background: none; color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
  .audience button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .audience .n { color: var(--muted); }
  .findings { padding: 0; margin: 0; border-top: 1px solid var(--border); }
  .known-section, .quiet, .not-checked { margin-top: 1.5rem; }
  .known-section summary, .standing summary { cursor: pointer; }
  .standing { margin-top: 1rem; }
  .standing h3 { display: inline; }
  .standing .sum { display: block; margin-top: 0.15rem; font-size: 0.85rem; color: var(--muted); }
  .known-section h3 { display: inline; }
  h3 { font-size: 1rem; margin: 0 0 0.25rem; }
  .quiet ul { margin: 0.25rem 0; padding-left: 1.1rem; font-size: 0.85rem; color: var(--muted); }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.5rem; }
  table { border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; font-weight: normal; padding: 0.15rem 1rem 0.15rem 0; vertical-align: top; white-space: nowrap; }
  td { color: var(--muted); overflow-wrap: anywhere; }
  .crashed { border: 1px solid var(--error); padding: 0.5rem 0.75rem; margin-bottom: 1rem; }
  @media (max-width: 640px) { th { white-space: normal; } }
</style>
