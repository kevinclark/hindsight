<!--
  One finding: severity, title and time; opens to evidence, a plot of the moment, the fix, the incident, and the
  buttons that track it as a known issue. Under it, collapsed, the findings it explains (report/finding-tree.ts).
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import type { Finding } from '../rules/types.ts'
  import { makerOf } from '../rules/index.ts'
  import type { IssueEvent, IssueStatus } from '../triage/history.ts'
  import Plot from './Plot.svelte'
  import { plotModel } from './plot-data.ts'
  import FindingRow from './FindingRow.svelte'
  import { descendants, severityWords, type FindingNode } from '../report/finding-tree.ts'
  import { shortTitle } from '../report/titles.ts'
  import { keyNumber } from '../report/review-model.ts'

  let { finding, analysis, issue, fixedLater = false, onMark, explains = [], note, nested = false, via, issues, wrong, sure, statusOf, showNext = false, real }: {
    finding: Finding
    analysis: Analysis
    issue?: IssueEvent
    /** Marked fixed, but the fix came after this match was played. */
    fixedLater?: boolean
    onMark: (finding: Finding, status: IssueStatus, note: string) => void
    /** The findings this one explains, shown collapsed under it. */
    explains?: FindingNode[]
    /** Something explains this finding but it is listed on its own: says what. */
    note?: string
    /** Shown under the finding that explains it. */
    nested?: boolean
    /** For a row in the flat list under a headline: the title of the finding that explains it, when that is not the headline itself. */
    via?: string
    /** For the rows under this one: their known-issue state. */
    issues?: Map<string, IssueEvent>
    /** This match's "not a real problem" marks, by issue key (this row's and the rows under it). */
    wrong?: Map<string, IssueEvent>
    /** This match's "real problem" marks, by issue key. */
    real?: Map<string, IssueEvent>
    /** The check's "How sure" line from the team's marks (null: no marks to go on). */
    sure?: (rule: string) => string | null
    statusOf?: (f: Finding) => string | undefined
    /** The list's first active error: its closed row carries the next step and who acts (derived by the list, so it moves when that error is marked known or the audience changes). */
    showNext?: boolean
  } = $props()
  const under = $derived(explains.flatMap((c) => [c.finding, ...descendants(c)]))
  // One level under the headline, in tree order: a finding that hangs off another explained finding says so on its own line instead of opening a disclosure inside a disclosure.
  type Flat = { node: FindingNode; via?: string }
  const flatten = (nodes: FindingNode[], parent?: Finding): Flat[] =>
    nodes.flatMap((n) => [{ node: n, via: parent ? shortTitle(parent.title) : undefined }, ...flatten(n.children, n.finding)])
  const flat = $derived(flatten(explains))
  const rule = $derived(makerOf(finding.rule))
  const wrongMark = $derived(wrong?.get(finding.key))
  const realMark = $derived(wrongMark ? undefined : real?.get(finding.key))
  const cameBack = $derived(issue?.status === 'fixed' && !fixedLater && !wrongMark)
  const howSure = $derived(sure?.(finding.rule) ?? null)
  const LABEL = { error: 'Error', warning: 'Warning', info: 'Info' } as const
  const ICON = { error: '●', warning: '▲', info: '○' } as const
  const WHO = { software: 'software team', pit: 'pit crew', drive: 'drive team' } as const
  // The headline shows only the rule's judged measurement: the evidence fallback reads oddly beside a title ("0 times during the match" next to "(1×)").
  const key = $derived(keyNumber(finding))
  // Every row starts closed except one that came back after a fix; the reader can open or close any row after that.
  // svelte-ignore state_referenced_locally
  let open = $state(!nested && issue?.status === 'fixed' && !fixedLater && !wrong?.has(finding.key))
  const who = $derived(rule ? rule.who.map((a) => WHO[a]).join(', ') : '')

  function mark(status: IssueStatus) {
    const ask = status === 'known' ? 'What do we know about it? (e.g. "belt slipping on 17/18, new belt before elims")'
      : status === 'fixed' ? 'What fixed it? (e.g. "replaced belt, retensioned")'
      : status === 'wrong' ? 'Why is this not a real problem on this match? (e.g. "deliberate A-stop", "zero kept through a restart")'
      : status === 'real' ? 'What happened? (optional, e.g. "lost auto" or a link to the report)' : ''
    let note: string | null = status === 'new' || status === 'unmark' ? '' : window.prompt(ask, status === 'wrong' || status === 'real' ? '' : (issue?.note ?? ''))
    // A wrong mark needs its reason: it turns this check's reds amber on the event's other matches.
    while (status === 'wrong' && note !== null && !note.trim()) note = window.prompt(`A reason is needed. ${ask}`, '')
    if (note === null) return // cancelled
    onMark(finding, status, note.trim())
  }
  const date = (iso: string) => iso.slice(0, 10)
</script>

<li class={`finding ${finding.severity}`} class:known={issue?.status === 'known' || fixedLater || !!wrongMark}>
  <details bind:open>
    <summary>
      <span class="sev" title={LABEL[finding.severity]}><span aria-hidden="true">{ICON[finding.severity]}</span> {LABEL[finding.severity]}</span>
      <span class="title">
        {#if cameBack}<span class="badge back">Came back after a fix</span>{/if}
        {#if wrongMark}<span class="badge known-badge">Not a real problem</span>{:else if realMark}<span class="badge real-badge">Real problem</span>{/if}
        {#if !wrongMark && issue?.status === 'known'}<span class="badge known-badge">Known</span>{/if}
        {#if fixedLater && !wrongMark}<span class="badge known-badge">{issue?.when ? 'Fixed after this match' : 'Fixed (date unknown)'}</span>{/if}
        {finding.title}
        {#if nested && finding.explainedBy}<span class="why">↳ {via ? `explained by ${via}: ` : ''}{finding.explainedBy.why}</span>{/if}
        {#if note}<span class="why">↳ {note}</span>{/if}
        {#if finding.demoted}<span class="why">↳ amber, not red: marked not a real problem in {finding.demoted.match}{finding.demoted.reason ? `: ${finding.demoted.reason}` : ''}</span>{/if}
        {#if finding.measured?.length && !key.inTitle}<span class="key">{key.value}{key.label ? ` ${key.label}` : ''}</span>{/if}
      </span>
      <span class="rule">{finding.rule}</span>
      {#if showNext && !open}<span class="next"><strong>Next step:</strong> {finding.nextStep}{#if who}{' · '}<strong>Who acts:</strong> {who}{/if}</span>{/if}
    </summary>
    <div class="body">
      {#if finding.run && analysis.match.runs.length > 1}<p class="issue-note" data-run>Run {finding.run} of {analysis.match.runs.length}{finding.when ? `: ${finding.when}` : ''}</p>{/if}
      {#if wrongMark}
        <p class="issue-note"><strong>Not a real problem</strong> on this match, marked {date(wrongMark.when)}: {wrongMark.note}</p>
      {/if}
      {#if realMark}
        <p class="issue-note"><strong>A real problem</strong> on this match, marked {date(realMark.when)}{realMark.note ? `: ${realMark.note}` : ''}</p>
      {/if}
      {#if !wrongMark && issue}
        <p class="issue-note">
          <strong>{issue.status === 'known' ? 'Known issue' : 'Marked fixed'}</strong> on {date(issue.when)}{issue.match ? ` (${issue.match})` : ''}{issue.note ? `: ${issue.note}` : ''}
        </p>
      {/if}
      {#if finding.demoted}
        <p class="issue-note">This check was marked not a real problem in {finding.demoted.match} on {date(finding.demoted.when)}{finding.demoted.reason ? ` ("${finding.demoted.reason}")` : ''}, so its reds this event show amber. Mark this one too if it is the same, or as a real problem if it is real.</p>
      {/if}
      {#if howSure}<p class="sure"><strong>How sure:</strong> {howSure}.</p>{/if}
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
        {#if 'sources' in rule}
          <div class="incident">
            <strong>Further reading:</strong>
            <ul class="reading">
              {#each rule.sources as source (source.url)}
                <li><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{' '}<span class="kind">({source.kind})</span>: {source.says}</li>
              {/each}
            </ul>
          </div>
        {/if}
        <p class="incident"><strong>Who acts:</strong> {who} · <strong>Tracked as:</strong> <code>{finding.key}</code></p>
      {/if}
      <div class="actions">
        {#if wrongMark || issue?.status !== 'known'}<button onclick={() => mark('known')}>Mark as known…</button>{/if}
        {#if wrongMark || issue?.status !== 'fixed'}<button onclick={() => mark('fixed')}>Mark as fixed…</button>{/if}
        {#if !realMark}<button onclick={() => mark('real')}>Real problem…</button>{/if}
        {#if !wrongMark}<button onclick={() => mark('wrong')}>Not a real problem…</button>{/if}
        {#if wrongMark}<button onclick={() => mark('unmark')}>Undo "not a real problem"</button>{:else if realMark}<button onclick={() => mark('unmark')}>Undo "real problem"</button>{/if}
        {#if issue && !wrongMark}<button onclick={() => mark('new')}>Treat as new</button>{/if}
      </div>
    </div>
  </details>
  {#if explains.length}
    <details class="explains">
      <summary>Explains {under.length} more ({severityWords(under)})</summary>
      <ul>
        {#each flat as { node: c, via } (c.finding.key + c.finding.time)}
          <FindingRow finding={c.finding} nested {via} {analysis} {issues} {wrong} {real} {sure} {statusOf} issue={issues?.get(c.finding.key)} fixedLater={statusOf?.(c.finding) === 'fixed later'} {onMark} />
        {/each}
      </ul>
    </details>
  {/if}
</li>

<style>
  .finding { border-bottom: 1px solid var(--border); list-style: none; }
  summary { display: grid; grid-template-columns: 6.5rem 1fr auto; gap: 0.75rem; align-items: baseline; padding: 0.4rem 0.25rem; cursor: pointer; }
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
  .real-badge { border: 1px solid var(--error); color: var(--error); }
  .key { margin-left: 0.5rem; font-size: 0.8rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .next { grid-column: 2 / 4; font-size: 0.85rem; color: var(--muted); }
  .rule { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
  .body { padding: 0 0.25rem 0.9rem 7.25rem; }
  .issue-note { font-size: 0.85rem; margin: 0 0 0.5rem; padding: 0.25rem 0.6rem; border-left: 3px solid var(--muted); }
  .sure { font-size: 0.85rem; margin: 0 0 0.5rem; color: var(--muted); }
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
  .reading { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .reading li { margin: 0.15rem 0; }
  .reading a { color: inherit; }
  .why { display: block; font-size: 0.8rem; color: var(--muted); }
  .explains { margin: 0 0 0.25rem 7.25rem; }
  .explains > summary { display: block; min-height: 24px; box-sizing: border-box; padding: 0.1rem 0.25rem; font-size: 0.85rem; color: var(--muted); }
  .explains > summary::before { content: '▸ '; }
  .explains[open] > summary::before { content: '▾ '; }
  .explains > ul { padding: 0; margin: 0; border-left: 2px solid var(--border); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .actions button { padding: 0.25rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
  .actions button:hover { border-color: var(--muted); }
  @media (max-width: 640px) {
    summary { grid-template-columns: 1fr; gap: 0.15rem; }
    /* The wide layout puts this under columns 2 to 4; on one column that would add two implicit columns and squeeze the title (WCAG 1.4.10 reflow). */
    .next { grid-column: 1; }
    .body { padding-left: 0.25rem; }
    .explains { margin-left: 0.25rem; }
  }
</style>
