<!--
  The printed Match review report: hidden on screen, the only thing shown under @media print (App.svelte hides the
  rest). Page 1 stands alone (the bottom line, each error with its one number, next step and plot, then warnings and
  info one line each); the pages after it hold the detail. Same findings, wording and known-issue split as the
  Match tab (report/review-model.ts), no controls.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import type { IssueEvent } from '../triage/history.ts'
  import { ruleById } from '../rules/index.ts'
  import { incidentFor, keyNumber, reviewModel, shortWhen } from '../report/review-model.ts'
  import { stamp } from '../report/foresight-model.ts'
  import Plot from './Plot.svelte'
  import { plotModel } from './plot-data.ts'

  let { analysis, issues }: { analysis: Analysis; issues: Map<string, IssueEvent> } = $props()
  const m = $derived(reviewModel(analysis, issues))
  const h = $derived(m.header)
  const WHO = { software: 'software team', pit: 'pit crew', drive: 'drive team' } as const
  const issueFor = (key: string) => issues.get(key)
</script>

<article class="print-only report" aria-hidden="true">
  <header class="rh">
    <h1>Hindsight match report</h1>
    <p class="strong">{h.robot}{h.event ? ` · ${h.event}` : ''} · {h.matchLabel || 'Match'}{h.date ? ` · ${h.date}` : ''}</p>
    <p class="meta">Log <code>{h.logFile}</code>{#each h.dsFiles as d (d)}{' + '}<code>{d}</code>{/each} · {h.build.text} · Hindsight {h.version}</p>
  </header>

  <p class="bottom">{m.bottomLine}</p>

  {#if m.errors.length}
    <section>
      <h2>Errors ({m.errors.length})</h2>
      {#each m.errors as f (f.key + f.time)}
        {@const k = keyNumber(f)}
        <div class="err">
          <div class="txt">
            <p class="title"><span class="sev error">Error</span>{f.title}</p>
            <p class="num">{#if k.label}<span class="s"><span class="n">{k.value}</span> {k.label}</span>{/if}{#if f.when && !f.title.includes(shortWhen(f.when))}<span class="s">{shortWhen(f.when)}</span>{/if}<code class="s">{f.rule}</code></p>
            <p class="next"><strong>Next step:</strong> {f.nextStep}</p>
          </div>
          {#if f.plot}<div class="plot"><Plot model={plotModel(analysis.match, f.plot)} height={52} compact /></div>{/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if m.warnings.length}
    <section>
      <h2>Warnings ({m.warnings.length})</h2>
      <ul class="lines">{#each m.warnings as f (f.key + f.time)}<li><span class="sev warning">Warning</span><span class="t">{f.title}</span><code>{f.rule}</code></li>{/each}</ul>
    </section>
  {/if}
  {#if m.infos.length}
    <section>
      <h2>Info ({m.infos.length})</h2>
      <ul class="lines">{#each m.infos as f (f.key + f.time)}<li><span class="sev info">Info</span><span class="t">{f.title}</span><code>{f.rule}</code></li>{/each}</ul>
    </section>
  {/if}
  {#if m.known.length}
    <section>
      <h2>Known issues seen this match ({m.known.length})</h2>
      <ul class="lines">{#each m.known as f (f.key + f.time)}<li><span class="sev info">{f.severity === 'error' ? 'Error' : f.severity === 'warning' ? 'Warning' : 'Info'}</span><span class="t"><span class="badge">Known</span> {f.title}</span><code>{f.rule}</code></li>{/each}</ul>
    </section>
  {/if}
  <p class="notchecked"><strong>Not checked ({m.notChecked.length}):</strong> {m.notChecked.length ? m.notChecked.map((s) => s.rule).join(', ') + '. These rules could not run on this log, so their silence means nothing.' : 'every rule ran.'}</p>
  <p class="foot">The same run as data: <code>{m.jsonFile}</code> (schema <code>{m.schema}</code>) · printed {stamp(new Date()).slice(0, 10)}</p>

  {#if m.errors.length}
    <section class="detail">
      <h2>Detail for each error</h2>
      {#each m.errors as f (f.key + f.time)}
        {@const rule = ruleById(f.rule)}
        {@const note = issueFor(f.key)}
        <div class="d">
          <p class="title"><span class="sev error">Error</span> {f.title}</p>
          {#if f.when}<p class="small">{f.when}</p>{/if}
          <p><strong>What this might mean:</strong> {f.meaning}</p>
          <p class="cl"><strong>Possible causes</strong>{f.causes.some((c) => c.likely) ? ' (tagged: what this log points to)' : ', most likely first'}:</p>
          <ol>
            {#each f.causes as c (c.id)}
              <li class:ruled={c.ruledOut}>{#if c.likely}<span class="tag">likely here</span>{/if}{#if c.ruledOut}<span class="tag">ruled out: {c.ruledOut}</span>{/if}{c.cause}. <span class="look">Look at: {c.look}</span></li>
            {/each}
          </ol>
          {#if rule}<p class="why"><strong>Why this rule exists:</strong> {incidentFor(f)} <span class="small">Who acts: {rule.who.map((a) => WHO[a]).join(', ')}.</span></p>{/if}
          {#if note}<p class="small">Tracked in the team's history as {note.status}{note.note ? `: ${note.note}` : ''}.</p>{/if}
        </div>
      {/each}
    </section>
  {/if}
</article>

<style>
  .print-only { display: none; }
  @media print {
    .print-only { display: block; font-size: 9pt; line-height: 1.18; color: var(--fg); }
  }
  h1 { font-size: 14pt; margin: 0; }
  h2 { font-size: 10pt; margin: 0.35rem 0 0.1rem; padding-bottom: 0.05rem; border-bottom: 1px solid var(--border); }
  p { margin: 0.08rem 0; }
  code { font-size: 0.85em; }
  .strong { font-weight: 600; font-size: 10.5pt; }
  .meta, .small, .foot { color: var(--muted); font-size: 8.5pt; overflow-wrap: anywhere; }
  .bottom { font-size: 10pt; font-weight: 600; margin: 0.3rem 0 0.05rem; }
  .sev { font-weight: 700; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 0.3rem; }
  .sev.error { color: var(--error); }
  .sev.warning { color: var(--warning); }
  .sev.info { color: var(--muted); }
  .err { display: grid; grid-template-columns: minmax(0, 1fr) 3.1in; gap: 0 0.2in; break-inside: avoid; padding: 0.1rem 0; border-bottom: 1px solid var(--border); }
  .err .title { font-weight: 700; font-size: 10pt; }
  .err .num { font-size: 8.5pt; }
  .err .num .s + .s::before { content: ' · '; color: var(--muted); }
  .err .num code { color: var(--muted); font-size: 8pt; }
  .err .num .n { font-weight: 700; font-variant-numeric: tabular-nums; }
  .err .next { font-size: 8.5pt; }
  .plot :global(figure) { margin: 0; }
  .plot :global(figcaption) { font-size: 7pt; padding-left: 44px; gap: 0 0.6rem; line-height: 1.15; }
  .lines { list-style: none; margin: 0; padding: 0; }
  .lines li { display: grid; grid-template-columns: 3.4rem minmax(0, 1fr) auto; gap: 0 0.5rem; align-items: baseline; padding: 0.03rem 0; border-bottom: 1px solid var(--border); font-size: 8pt; break-inside: avoid; }
  .lines li code { color: var(--muted); font-size: 7.5pt; white-space: nowrap; }
  .badge { font-size: 7.5pt; font-weight: 700; padding: 0 0.3rem; border: 1px solid var(--muted); border-radius: 3px; color: var(--muted); }
  .notchecked { font-size: 8pt; margin-top: 0.25rem; }
  .foot { margin-top: 0.1rem; font-size: 8pt; }
  .detail { break-before: page; }
  .d { break-inside: avoid; margin-bottom: 0.9rem; font-size: 9.5pt; }
  .d .title { font-weight: 700; font-size: 11pt; }
  .d ol { margin: 0.1rem 0 0.2rem; padding-left: 1.3rem; }
  .d li { margin: 0.1rem 0; }
  .look { color: var(--muted); }
  .tag { font-size: 7.5pt; font-weight: 700; padding: 0 0.3rem; margin-right: 0.3rem; border: 1px solid currentColor; border-radius: 3px; }
  .ruled { color: var(--muted); text-decoration: line-through; }
  .ruled .tag { text-decoration: none; display: inline-block; }
  .why { color: var(--muted); }
</style>
