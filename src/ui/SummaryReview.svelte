<!--
  Match review from a summary (the phone, stage 1): each finding worst first, its numbers, what it might mean, the next step,
  the causes with what this log pointed to, and the team's marks on it. Read only: no mark buttons. No plots yet (stage 2);
  the line under the heading says so, and where to see them.
-->
<script lang="ts">
  import type { MatchSummary } from '../session/summary.ts'
  import type { IssueEvent } from '../triage/history.ts'
  import { notChecked, reviewRows } from '../report/summary-review.ts'

  let { summary, issues, wrong, real, laptop, olderRead, onBack }: {
    summary: MatchSummary; issues: Map<string, IssueEvent>; wrong: Map<string, IssueEvent>; real: Map<string, IssueEvent>
    /** The laptop whose event file this summary came from, and the Hindsight version that read it when older than this one. */
    laptop: string | null; olderRead: string | null
    onBack?: () => void
  } = $props()

  const ICON = { error: '●', warning: '▲', info: '○' } as const
  const LABEL = { error: 'Error', warning: 'Warning', info: 'Info' } as const
  const rows = $derived(reviewRows(summary))
  const skipped = $derived(notChecked(summary))
  const counts = $derived((['error', 'warning', 'info'] as const).map((s) => [s, rows.filter((r) => r.finding.severity === s).length] as const).filter(([, n]) => n > 0))
  const date = (iso: string) => iso.slice(0, 10)
  const played = $derived(summary.playedAt === null ? 'time not known' : new Date(summary.playedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))
</script>

<section class="summary-review" data-summary-review>
  {#if onBack}<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Back</button></p>{/if}
  <h2>{summary.event ? `${summary.event} ` : ''}{summary.matchLabel || summary.fileName}</h2>
  <p class="meta">{played} · {summary.robot.name}{#if counts.length}{' · '}{counts.map(([s, n]) => `${n} ${s === 'info' ? 'info' : `${s}${n === 1 ? '' : 's'}`}`).join(', ')}{:else}{' · '}no findings{/if}</p>
  <p class="meta">From {laptop ? `laptop ${laptop}'s` : 'a laptop\'s'} summary{olderRead ? `, read with Hindsight ${olderRead}` : ''}. Plots are on the laptop: open the log there to see them.</p>

  {#if rows.length === 0}<p>No rule fired in this {summary.onField ? 'match' : 'log'}.</p>{/if}
  <ul class="findings">
    {#each rows as r (r.finding.key)}
      {@const f = r.finding}
      {@const w = wrong.get(f.key)}
      {@const re = real.get(f.key)}
      {@const issue = issues.get(f.key)}
      <li class={`finding ${f.severity}`} class:known={!!w || issue?.status === 'known'}>
        <details>
          <summary>
            <span class="sev"><span aria-hidden="true">{ICON[f.severity]}</span> {LABEL[f.severity]}</span>
            <span class="title">
              {#if w}<span class="badge">Not a real problem</span>{:else if re}<span class="badge real">Real problem</span>{/if}
              {#if !w && issue?.status === 'known'}<span class="badge">Known</span>{:else if !w && issue?.status === 'fixed'}<span class="badge">Marked fixed</span>{/if}
              {f.title}
            </span>
            <span class="rule">{f.rule}</span>
          </summary>
          <div class="body">
            {#if w}<p class="mark"><strong>Not a real problem</strong> on this match, marked {date(w.when)}: {w.note}</p>{/if}
            {#if re}<p class="mark"><strong>A real problem</strong> on this match, marked {date(re.when)}{re.note ? `: ${re.note}` : ''}</p>{/if}
            {#if !w && issue && (issue.status === 'known' || issue.status === 'fixed')}<p class="mark"><strong>{issue.status === 'known' ? 'Known issue' : 'Marked fixed'}</strong> on {date(issue.when)}{issue.match ? ` (${issue.match})` : ''}{issue.note ? `: ${issue.note}` : ''}</p>{/if}
            {#if Object.keys(f.evidence).length}
              <table class="evidence"><tbody>{#each Object.entries(f.evidence) as [k, v] (k)}<tr><th scope="row">{k}</th><td>{v}</td></tr>{/each}</tbody></table>
            {/if}
            {#if r.meaning}<p><strong>What this might mean:</strong> {r.meaning}</p>{/if}
            {#if r.nextStep}<p><strong>Next step:</strong> {r.nextStep}{#if r.who}{' · '}<strong>Who acts:</strong> {r.who}{/if}</p>{/if}
            {#if r.causes.length}
              <p class="causes-head"><strong>Possible causes</strong>{r.causes.some((c) => c.likely) ? ' (tagged: what this log points to)' : ', most likely first'}:</p>
              <ol class="causes">
                {#each r.causes as c (c.id)}
                  <li class:ruled-out={!!c.ruledOut}>{#if c.likely}<span class="tag">likely here</span>{/if}{#if c.ruledOut}<span class="tag">ruled out: {c.ruledOut}</span>{/if}{c.cause}. <span class="look">Look at: {c.look}</span></li>
                {/each}
              </ol>
            {/if}
            {#if r.incident}<p class="meta"><strong>Why this rule exists:</strong> {r.incident}</p>{/if}
            <p class="meta">Tracked as <code>{f.key}</code></p>
          </div>
        </details>
      </li>
    {/each}
  </ul>
  {#if skipped.length}
    <details class="skipped"><summary>{skipped.length} rule{skipped.length === 1 ? '' : 's'} not checked on this log</summary>
      <ul>{#each skipped as s (s.rule)}<li><code>{s.rule}</code>{s.reason ? `: ${s.reason}` : ''}</li>{/each}</ul>
    </details>
  {/if}
</section>

<style>
  h2 { margin: 0.2rem 0 0; font-size: 1.25rem; }
  .meta { margin: 0.15rem 0; color: var(--muted); font-size: 0.85rem; }
  .crumbs { margin: 0; }
  .link { border: none; background: none; color: var(--fg); text-decoration: underline; font: inherit; min-height: 44px; padding: 0 0.25rem; cursor: pointer; }
  .findings { list-style: none; padding: 0; margin: 0.75rem 0 0; }
  .finding { border-left: 4px solid var(--border); margin: 0 0 0.4rem; }
  .finding.error { border-left-color: var(--error); }
  .finding.warning { border-left-color: var(--warning); }
  /* Known or marked not a real problem: a grey edge, never faded text (opacity took the words under 4.5:1). */
  .finding.known { border-left-color: var(--muted); }
  /* One flow, not columns: at 375 px a severity column would take a quarter of the width from the words. */
  summary { display: block; padding: 0.55rem 0.6rem; min-height: 44px; box-sizing: border-box; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .sev { font-weight: 600; white-space: nowrap; margin-right: 0.4rem; }
  .error .sev { color: var(--error); }
  .warning .sev { color: var(--warning); }
  .rule { display: block; color: var(--muted); font-family: var(--mono); font-size: 0.8rem; overflow-wrap: anywhere; }
  .badge { display: inline-block; margin-right: 0.35rem; padding: 0 0.35rem; border: 1px solid var(--muted); border-radius: 4px; font-size: 0.75rem; color: var(--muted); }
  .badge.real { border-color: var(--error); color: var(--error); }
  .body { padding: 0 0.6rem 0.6rem; }
  .body p { margin: 0.35rem 0; }
  .mark { padding: 0.3rem 0.5rem; background: var(--hover); border-radius: 4px; }
  .evidence { border-collapse: collapse; font-size: 0.85rem; width: 100%; }
  .evidence th { text-align: left; font-weight: 400; color: var(--muted); padding: 0.15rem 0.5rem 0.15rem 0; vertical-align: top; }
  .evidence td { font-variant-numeric: tabular-nums; padding: 0.15rem 0; overflow-wrap: anywhere; }
  .causes { margin: 0.2rem 0; padding-left: 1.25rem; }
  .causes li { margin: 0.2rem 0; }
  .ruled-out { color: var(--muted); }
  .tag { display: inline-block; margin-right: 0.35rem; padding: 0 0.3rem; border: 1px solid var(--border); border-radius: 4px; font-size: 0.75rem; }
  .look { color: var(--muted); }
  .skipped { margin-top: 0.75rem; color: var(--muted); font-size: 0.85rem; }
  .skipped summary { display: block; padding: 0.4rem 0; }
</style>
