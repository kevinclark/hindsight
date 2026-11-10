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
  import { askText } from './ask-text.svelte.ts'
  import { plotModel } from './plot-data.ts'
  import FindingRow from './FindingRow.svelte'
  import { descendants, severityWords, type FindingNode } from '../report/finding-tree.ts'
  import { rowHeadline, shortTitle } from '../report/titles.ts'
  import PdpThumb from './PdpThumb.svelte'
  import { judgedAgainst } from '../power/power-map-view.ts'
  import { openPowerMap } from './power-map-bridge.svelte.ts'
  import { powerMapInstant } from '../analyze.ts'
  import { mapRobotIds, robotKey } from '../profiles/index.ts'

  let { finding, analysis, issue, fixedLater = false, onMark, explains = [], note, nested = false, via, issues, wrong, sure, statusOf, showNext = false, real, onDebug, experimental }: {
    finding: Finding
    analysis: Analysis
    issue?: IssueEvent
    /** Marked fixed, but the fix came after this match was played. */
    fixedLater?: boolean
    /** Without it (read only) the row draws no mark buttons. */
    onMark?: (finding: Finding, status: IssueStatus, note: string) => void
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
    /** Opens the debug workspace for this finding (ADR 3), when the page can record what the team finds. */
    onDebug?: (finding: Finding) => void
    /** An experimental rule's finding (ADR 14): why it isn't trusted yet. Drawn with no severity colour or icon; never given onMark or onDebug. */
    experimental?: string
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
  // The closed row leads with the rule's short title, the part, the judged measurement (never the evidence fallback) and the time; the long sentence opens inside.
  const head = $derived(rowHeadline(finding))
  const rest = $derived([head.about, head.key].filter(Boolean))
  // Every row starts closed except one that came back after a fix; the reader can open or close any row after that.
  // svelte-ignore state_referenced_locally
  let open = $state(!nested && issue?.status === 'fixed' && !fixedLater && !wrong?.has(finding.key))
  const who = $derived(rule ? rule.who.map((a) => WHO[a]).join(', ') : '')

  async function mark(status: IssueStatus) {
    const ask = status === 'known' ? 'What do we know about it? (e.g. "belt slipping on 17/18, new belt before elims")'
      : status === 'fixed' ? 'What fixed it? (e.g. "replaced belt, retensioned")'
      : status === 'wrong' ? 'Why is this not a real problem on this match? (e.g. "deliberate A-stop", "zero kept through a restart")'
      : status === 'real' ? 'What happened? (optional, e.g. "lost auto" or a link to the report)' : ''
    let note: string | null = status === 'new' || status === 'unmark' ? '' : await askText(ask, status === 'wrong' || status === 'real' ? '' : (issue?.note ?? ''))
    // A wrong mark needs its reason: it turns this check's reds amber on the event's other matches.
    while (status === 'wrong' && note !== null && !note.trim()) note = await askText(`A reason is needed. ${ask}`, '')
    if (note === null) return // cancelled
    onMark?.(finding, status, note.trim())
  }
  const date = (iso: string) => iso.slice(0, 10)

  // A motor's breaker finding says which breaker it was judged against and where it sits (the power map), with a thumbnail of the PDP
  // and a way to change it. Only inside the opened finding; nothing on the main-breaker finding beyond its evidence row.
  const isPdp = $derived(finding.rule === 'power/pdp-breaker-margin')
  const pdpSlot = $derived(isPdp ? /^PDP slot (\d+)$/.exec(String(finding.evidence.slot ?? ''))?.[1] : undefined)
  const judged = $derived(isPdp ? judgedAgainst(finding.evidence, analysis.match.powerMap) : '')
  function changeBreaker() {
    const iso = powerMapInstant(analysis.match)
    const known = !iso.startsWith('9999')
    openPowerMap({ robot: robotKey(analysis.match.profile as never), ...(pdpSlot !== undefined ? { slot: Number(pdpSlot) } : {}), ...(known ? { from: { iso, label: analysis.match.matchLabel || analysis.match.fileName } } : {}) })
  }
</script>

<li class={`finding ${experimental ? 'experimental' : finding.severity}`} class:known={issue?.status === 'known' || fixedLater || !!wrongMark}>
  <details bind:open>
    <summary>
      {#if experimental}<span class="sev" title={`Experimental: ${experimental}`}><span aria-hidden="true">◇</span> Experimental</span>
      {:else}<span class="sev" title={LABEL[finding.severity]}><span aria-hidden="true">{ICON[finding.severity]}</span> {LABEL[finding.severity]}</span>{/if}
      <span class="title">
        {#if cameBack}<span class="badge back">Came back after a fix</span>{/if}
        {#if wrongMark}<span class="badge known-badge">Not a real problem</span>{:else if realMark}<span class="badge real-badge">Real problem</span>{/if}
        {#if !wrongMark && issue?.status === 'known'}<span class="badge known-badge">Known</span>{/if}
        {#if fixedLater && !wrongMark}<span class="badge known-badge">{issue?.when ? 'Fixed after this match' : 'Fixed (date unknown)'}</span>{/if}
        <b>{head.lead}</b>{#each rest as part, i (i)}{' · '}{part}{/each}
        {#if nested && finding.explainedBy}<span class="why">↳ {via ? `explained by ${via}: ` : ''}{finding.explainedBy.why}</span>{/if}
        {#if note}<span class="why">↳ {note}</span>{/if}
        {#if finding.demoted}<span class="why">↳ amber, not red: marked not a real problem in {finding.demoted.match}{finding.demoted.reason ? `: ${finding.demoted.reason}` : ''}</span>{/if}
      </span>
      <span class="when">{head.time}</span>
      <span class="rule">{finding.rule}</span>
      {#if showNext && !open}<span class="next"><strong>Next step:</strong> {finding.nextStep}{#if who}{' · '}<strong>Who acts:</strong> {who}{/if}</span>{/if}
    </summary>
    <div class="body">
      <p class="sentence">{finding.title}</p>
      {#if experimental}<p class="issue-note" data-experimental>Experimental: {experimental}. Not counted, never red, not on the board or the phone.</p>{/if}
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
      {#if isPdp}
        <div class="judged" data-judged-against>
          <div><strong>judged against:</strong> {judged} · <button type="button" class="link" onclick={changeBreaker}>Change</button></div>
          {#if pdpSlot !== undefined}<PdpThumb map={analysis.match.powerMap} slot={Number(pdpSlot)} robot={mapRobotIds(analysis.match.profile as never)} onclick={changeBreaker} />{/if}
        </div>
      {/if}
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
        {#if onDebug && rule && 'causes' in rule && rule.causes.length}<button class="debug" onclick={() => onDebug(finding)}>Debug this</button>{/if}
        {#if onMark}
        {#if wrongMark || issue?.status !== 'known'}<button onclick={() => mark('known')}>Mark as known…</button>{/if}
        {#if wrongMark || issue?.status !== 'fixed'}<button onclick={() => mark('fixed')}>Mark as fixed…</button>{/if}
        {#if !realMark}<button onclick={() => mark('real')}>Real problem…</button>{/if}
        {#if !wrongMark}<button onclick={() => mark('wrong')}>Not a real problem…</button>{/if}
        {#if wrongMark}<button onclick={() => mark('unmark')}>Undo "not a real problem"</button>{:else if realMark}<button onclick={() => mark('unmark')}>Undo "real problem"</button>{/if}
        {#if issue && !wrongMark}<button onclick={() => mark('new')}>Treat as new</button>{/if}
        {/if}
      </div>
    </div>
  </details>
  {#if explains.length}
    <details class="explains">
      <summary>Explains {under.length} more ({severityWords(under)})</summary>
      <ul>
        {#each flat as { node: c, via } (c.finding.key + c.finding.time)}
          <FindingRow finding={c.finding} nested {via} {analysis} {issues} {wrong} {real} {sure} {statusOf} issue={issues?.get(c.finding.key)} fixedLater={statusOf?.(c.finding) === 'fixed later'} {onMark} {onDebug} />
        {/each}
      </ul>
    </details>
  {/if}
</li>

<style>
  .judged { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0.5rem 0; font-size: 0.9rem; }
  .judged .link { background: none; border: none; padding: 0; color: var(--link, var(--fg)); text-decoration: underline; cursor: pointer; font: inherit; min-height: 24px; }
  .finding { border-bottom: 1px solid var(--border); list-style: none; }
  summary { display: grid; grid-template-columns: 6.5rem 1fr 9.5rem 13.5rem; gap: 0.75rem; align-items: baseline; padding: 0.4rem 0.25rem; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--hover); }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .sev { font-weight: 600; font-size: 0.85rem; white-space: nowrap; }
  .error .sev { color: var(--error); }
  .warning .sev { color: var(--warning); }
  .info .sev, .known .sev, .experimental .sev { color: var(--muted); }
  .experimental { border: 1px dashed var(--border); border-radius: 4px; margin-bottom: 0.25rem; }
  .title { min-width: 0; overflow-wrap: anywhere; }
  .badge { font-size: 0.75rem; font-weight: 600; padding: 0.05rem 0.4rem; border-radius: 4px; margin-right: 0.35rem; white-space: nowrap; }
  .back { background: var(--error); color: var(--bg); }
  .known-badge { border: 1px solid var(--muted); color: var(--muted); }
  .real-badge { border: 1px solid var(--error); color: var(--error); }
  .sentence { margin: 0 0 0.5rem; max-width: 70ch; }
  .next { grid-column: 2 / 5; font-size: 0.85rem; color: var(--muted); }
  .when { text-align: right; font-size: 0.75rem; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .rule { font-family: var(--mono); font-size: 0.75rem; color: var(--muted); white-space: nowrap; text-align: right; }
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
    .when:empty { display: none; }
    /* The wide layout puts this under columns 2 to 4; on one column that would add two implicit columns and squeeze the title (WCAG 1.4.10 reflow). */
    .next { grid-column: 1; }
    .body { padding-left: 0.25rem; }
    .explains { margin-left: 0.25rem; }
  }
</style>
