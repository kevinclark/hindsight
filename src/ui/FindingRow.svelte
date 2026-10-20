<!--
  One finding: severity, title and time; opens to evidence, a plot of the moment, the fix, the incident, and the
  buttons that track it as a known issue. Under it, collapsed, the findings it explains (report/finding-tree.ts).
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import type { Finding } from '../rules/types.ts'
  import { ruleById } from '../rules/index.ts'
  import type { IssueEvent, IssueStatus } from '../triage/history.ts'
  import Plot from './Plot.svelte'
  import { plotModel } from './plot-data.ts'
  import FindingRow from './FindingRow.svelte'
  import { descendants, severityWords, type FindingNode } from '../report/finding-tree.ts'

  let { finding, analysis, issue, fixedLater = false, onMark, children = [], note, nested = false, issues, statusOf }: {
    finding: Finding
    analysis: Analysis
    issue?: IssueEvent
    /** Marked fixed, but the fix came after this match was played. */
    fixedLater?: boolean
    onMark: (finding: Finding, status: IssueStatus, note: string) => void
    /** The findings this one explains, shown collapsed under it. */
    children?: FindingNode[]
    /** Something explains this finding but it is listed on its own: says what. */
    note?: string
    /** Shown under the finding that explains it. */
    nested?: boolean
    /** For the rows under this one: their known-issue state. */
    issues?: Map<string, IssueEvent>
    statusOf?: (f: Finding) => string | undefined
  } = $props()
  const under = $derived(children.flatMap((c) => [c.finding, ...descendants(c)]))
  const rule = $derived(ruleById(finding.rule))
  const cameBack = $derived(issue?.status === 'fixed' && !fixedLater)
  const LABEL = { error: 'Error', warning: 'Warning', info: 'Info' } as const
  const ICON = { error: '●', warning: '▲', info: '○' } as const
  const WHO = { software: 'software team', pit: 'pit crew', drive: 'drive team' } as const
  // Errors start open; the reader can open or close any row after that.
  // svelte-ignore state_referenced_locally
  let open = $state(!nested && ((finding.severity === 'error' && !issue) || (issue?.status === 'fixed' && !fixedLater)))

  function mark(status: IssueStatus) {
    const ask = status === 'known' ? 'What do we know about it? (e.g. "belt slipping on 17/18, new belt before elims")'
      : status === 'fixed' ? 'What fixed it? (e.g. "replaced belt, retensioned")' : ''
    const note = status === 'new' ? '' : window.prompt(ask, issue?.note ?? '')
    if (note === null) return // cancelled
    onMark(finding, status, note.trim())
  }
  const date = (iso: string) => iso.slice(0, 10)
</script>

<li class={`finding ${finding.severity}`} class:known={issue?.status === 'known' || fixedLater}>
  <details bind:open>
    <summary>
      <span class="sev" title={LABEL[finding.severity]}><span aria-hidden="true">{ICON[finding.severity]}</span> {LABEL[finding.severity]}</span>
      <span class="title">
        {#if cameBack}<span class="badge back">Came back after a fix</span>{/if}
        {#if issue?.status === 'known'}<span class="badge known-badge">Known</span>{/if}
        {#if fixedLater}<span class="badge known-badge">{issue?.when ? 'Fixed after this match' : 'Fixed (date unknown)'}</span>{/if}
        {finding.title}
        {#if nested && finding.explainedBy}<span class="why">↳ {finding.explainedBy.why}</span>{/if}
        {#if note}<span class="why">↳ {note}</span>{/if}
      </span>
      <span class="rule">{finding.rule}</span>
    </summary>
    <div class="body">
      {#if issue}
        <p class="issue-note">
          <strong>{issue.status === 'known' ? 'Known issue' : 'Marked fixed'}</strong> on {date(issue.when)}{issue.match ? ` (${issue.match})` : ''}{issue.note ? `: ${issue.note}` : ''}
        </p>
      {/if}
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
      <p class="fix"><strong>What this might mean:</strong> {finding.meaning}</p>
      <p class="fix"><strong>Next step:</strong> {finding.nextStep}</p>
      <div class="fix">
        <strong>Possible causes</strong>{finding.causes.some((c) => c.likely) ? ' (tagged: what this log points to)' : ', most likely first'}:
        <ol class="causes">
          {#each finding.causes as c (c.id)}
            <li class:likely={c.likely} class:ruled-out={c.ruledOut}>
              {#if c.likely}<span class="tag">likely here</span>{/if}{#if c.ruledOut}<span class="tag">ruled out: {c.ruledOut}</span>{/if}
              {c.cause}. <span class="look">Look at: {c.look}</span>
            </li>
          {/each}
        </ol>
      </div>
      {#if rule}
        <p class="incident"><strong>Why this rule exists:</strong> {rule.incident}</p>
        <p class="incident"><strong>Who acts:</strong> {rule.who.map((a) => WHO[a]).join(', ')} · <strong>Tracked as:</strong> <code>{finding.key}</code></p>
      {/if}
      <div class="actions">
        {#if issue?.status !== 'known'}<button onclick={() => mark('known')}>Mark as known…</button>{/if}
        {#if issue?.status !== 'fixed'}<button onclick={() => mark('fixed')}>Mark as fixed…</button>{/if}
        {#if issue}<button onclick={() => mark('new')}>Treat as new</button>{/if}
      </div>
    </div>
  </details>
  {#if children.length}
    <details class="explains">
      <summary>Explains {under.length} more ({severityWords(under)})</summary>
      <ul>
        {#each children as c (c.finding.key + c.finding.time)}
          <FindingRow finding={c.finding} children={c.children} nested {analysis} {issues} {statusOf} issue={issues?.get(c.finding.key)} fixedLater={statusOf?.(c.finding) === 'fixed later'} {onMark} />
        {/each}
      </ul>
    </details>
  {/if}
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
  .info .sev, .known .sev { color: var(--muted); }
  .title { min-width: 0; overflow-wrap: anywhere; }
  .badge { font-size: 0.75rem; font-weight: 600; padding: 0.05rem 0.4rem; border-radius: 4px; margin-right: 0.35rem; white-space: nowrap; }
  .back { background: var(--error); color: var(--bg); }
  .known-badge { border: 1px solid var(--muted); color: var(--muted); }
  .rule { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
  .body { padding: 0 0.25rem 0.9rem 7.25rem; }
  .issue-note { font-size: 0.85rem; margin: 0 0 0.5rem; padding: 0.25rem 0.6rem; border-left: 3px solid var(--muted); }
  .evidence { border-collapse: collapse; font-size: 0.85rem; }
  .evidence th { text-align: left; font-weight: normal; color: var(--muted); padding: 0.1rem 1rem 0.1rem 0; vertical-align: top; }
  .evidence td { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .fix, .incident { font-size: 0.85rem; margin: 0.5rem 0 0; max-width: 70ch; }
  .causes { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .causes li { margin: 0.15rem 0; }
  .causes .look { color: var(--muted); }
  .causes .tag { font-size: 0.75rem; font-weight: 600; padding: 0 0.35rem; margin-right: 0.35rem; border-radius: 4px; border: 1px solid currentColor; }
  .causes .likely .tag { color: var(--warning); }
  .causes .ruled-out { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--border); }
  .causes .ruled-out .tag { text-decoration: none; display: inline-block; }
  .incident { color: var(--muted); }
  .why { display: block; font-size: 0.8rem; color: var(--muted); }
  .explains { margin: 0 0 0.4rem 7.25rem; }
  .explains > summary { display: block; padding: 0.2rem 0.25rem; font-size: 0.85rem; color: var(--muted); }
  .explains > summary::before { content: '▸ '; }
  .explains[open] > summary::before { content: '▾ '; }
  .explains > ul { padding: 0; margin: 0; border-left: 2px solid var(--border); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .actions button { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
  .actions button:hover { border-color: var(--muted); }
  @media (max-width: 640px) {
    summary { grid-template-columns: 1fr; gap: 0.15rem; }
    .body { padding-left: 0.25rem; }
    .explains { margin-left: 0.25rem; }
  }
</style>
