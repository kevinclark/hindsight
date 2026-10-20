<!--
  The printed Session report: hidden on screen, the only thing shown under @media print (App.svelte hides the rest).
  Page 1 stands alone (the matches, the bottom line, the merged findings with their confidence in words, the trends
  as small multiples on one scale, the notes); page 2 is the rule × match grid. Same findings and wording as the
  Session view (report/session-model.ts), no controls. Severity and confidence are words, battery identity is a
  letter, a grid cell is a symbol: it reads in greyscale (WCAG 2.2 SC 1.4.1).
-->
<script lang="ts">
  import type { Session } from '../session/session.ts'
  import type { IssueEvent } from '../triage/history.ts'
  import { buildText, sessionModel } from '../report/session-model.ts'

  let { session, issues, typedBatteries }: { session: Session; issues: Map<string, IssueEvent>; typedBatteries: Record<string, string> } = $props()
  const m = $derived(sessionModel(session, issues, typedBatteries))
  const t = $derived(m.trends)
  // Every point with a battery carries its letter (smaller past 24 matches, where they crowd): never colour alone.
  const crowded = $derived(m.matchCount > 24)
  const SYMBOL = { fired: '●', quiet: '·', 'not checked': '–' } as const
  const WORD = { fired: 'fired', quiet: 'quiet', 'not checked': 'not checked' } as const
  const turned = $derived(m.matchCount > 6)
</script>

<article class="print-only report" aria-hidden="true">
  <header class="rh">
    <h1>Hindsight session report</h1>
    <p class="strong">{m.label}{m.label.toLowerCase().startsWith(m.kind.toLowerCase().split(' ')[0]) ? '' : ` (${m.kind.toLowerCase()})`}{m.dates ? ` · ${m.dates}` : ''} · {m.matchCount} {m.matchCount === 1 ? 'match' : 'matches'}</p>
    <p class="meta" class:dirty={m.uncommitted > 0}>{buildText(m)} · Hindsight {m.version}</p>
  </header>

  <p class="bottom">{m.bottomLine}</p>

  <section>
    <h2>Findings across the session ({m.findings.length}{m.onceFold ? `: ${m.rows.length} repeated, ${m.onceFold.count} seen once` : ''})</h2>
    {#if m.findings.length === 0}
      <p class="small">No errors or warnings in any match.</p>
    {:else}
      <ul class="finds">
        {#each m.rows as f (f.key)}
          <li class="sr-find">
            <span class={`sev ${f.severity}`}>{f.sevWord}</span>
            <span class={`conf ${f.confidence.replace(/ /g, '-')}`}>{f.confidenceWord}</span>
            <span class="t">{#if f.cameBack.length}<span class="badge">Came back after a fix ({f.cameBack.join(', ')})</span> {/if}<strong class="ttl">{f.title}</strong>
              <span class="small">{f.rateText}{f.measured ? ` · ${f.measured}` : ''} · <code>{f.key}</code></span></span>
          </li>
        {/each}
      </ul>
      {#if m.onceFold}<p class="once"><strong>Once ({m.onceFold.count} in {m.onceFold.rules} {m.onceFold.rules === 1 ? 'rule' : 'rules'}):</strong> {m.onceFold.text}. Each one is a row in <code>{m.jsonFile}</code> and a cell in the grid on the next page.</p>{/if}
    {/if}
  </section>

  <section class="trends">
    <h2>Per match, one scale per number</h2>
    <p class="small">Matches left to right: {t.order.join(', ')}.{t.batteries.length ? ' Letters mark the battery: ' : ''}{#each t.batteries as b (b.letter)}<span class="bk"><strong>{b.letter}</strong> = {b.id}</span>{/each}{#if t.batteries.length && t.anyUnlabelled}<span class="bk">no letter = no battery ID</span>{/if}{#if !t.batteries.length}{' '}No battery IDs in these logs.{/if} Dashed line: the rule's line.</p>
    <div class="multiples">
      {#each t.panels as p (p.key)}
        <figure>
          <figcaption>{p.label} <span>({p.unit})</span></figcaption>
          {#if p.points.length}
            <svg viewBox={`0 0 ${t.width} ${t.height}`} role="img" aria-label={`${p.label} per match`}>
              {#if p.lineY !== null}<line class="ref" x1="6" x2={t.width - 6} y1={p.lineY} y2={p.lineY} />{/if}
              {#each p.points as pt (pt.id)}
                <circle cx={pt.x} cy={pt.y} r="3.2" class="pt" />
                {#if pt.letter}<text x={pt.x + 4.5} y={pt.y - 3.5} class={`lt ${crowded ? 'small' : ''}`}>{pt.letter}</text>{/if}
              {/each}
            </svg>
            <div class="range">{p.range}</div>
          {:else}
            <p class="range">not in these logs</p>
          {/if}
        </figure>
      {/each}
    </div>
  </section>

  {#if m.notes.length}
    <section class="notes">
      <h2>Notes</h2>
      {#each m.notes as n (n)}<p class="small">{n}</p>{/each}
    </section>
  {/if}

  <section class="gridpage">
    <h1 class="h1b">Rule × match</h1>
    <p class="small">● fired · quiet – not checked (signals missing, no robot profile fits the log, or the rule crashed). Rules that fired in any match come first.</p>
    <table class="grid">
      <thead>
        <tr><th class="r">rule</th>{#each m.grid.columns as c (c.id)}<th class="c"><span class:turn={turned}>{c.label}</span></th>{/each}<th class="r">across the session</th></tr>
      </thead>
      <tbody>
        {#each m.grid.rows as r (r.rule)}
          <tr class:any={r.firedAnywhere}>
            <th scope="row" class="r"><code>{r.rule}</code></th>
            {#each r.cells as c, i (i)}<td class={`cell ${c.replace(/ /g, '-')}`} aria-label={WORD[c]}>{SYMBOL[c]}</td>{/each}
            <td class="rate">{r.rate}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
  <p class="foot">The same session as data: <code>{m.jsonFile}</code> (schema <code>{m.schema}</code>)</p>
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
  .meta, .small, .foot { color: var(--muted); font-size: 8pt; overflow-wrap: anywhere; }
  .meta.dirty { color: var(--warning); font-weight: 600; }
  .bottom { font-size: 10pt; font-weight: 600; margin: 0.3rem 0 0.05rem; }
  .finds { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: max-content max-content minmax(0, 1fr); }
  .finds li { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; column-gap: 0.4rem; align-items: baseline; padding: 0.01rem 0; border-bottom: 1px solid var(--border); break-inside: avoid; }
  .sev { font-weight: 700; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.03em; }
  .sev.error { color: var(--error); }
  .sev.warning { color: var(--warning); }
  .conf { font-size: 7.5pt; font-weight: 700; padding: 0 0.2rem; white-space: nowrap; border: 1px solid var(--muted); border-radius: 999px; text-align: center; color: var(--muted); }
  .conf.consistent { border: 1.5px solid var(--error); color: var(--error); }
  .conf.intermittent { border: 1.5px solid var(--warning); color: var(--warning); }
  .conf.once { border-style: dashed; }
  .t { display: block; }
  .ttl { font-size: 8pt; }
  .t .small { display: block; overflow-wrap: anywhere; font-size: 7pt; line-height: 1.08; }
  .badge { font-size: 7.5pt; font-weight: 700; padding: 0 0.3rem; border: 1px solid var(--error); border-radius: 3px; color: var(--error); }
  .multiples { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.15rem 0.4rem; margin-top: 0.15rem; }
  figure { margin: 0; break-inside: avoid; }
  figcaption { font-size: 6.5pt; line-height: 1.1; min-height: 2.2em; }
  figcaption span, .range { color: var(--muted); font-size: 6.5pt; }
  .multiples svg { width: 100%; height: auto; display: block; overflow: visible; border-bottom: 1px solid var(--border); }
  .pt { fill: var(--fg); }
  .lt.small { font-size: 5px; }
  .lt { font-size: 9px; font-weight: 700; fill: var(--fg); }
  .ref { stroke: var(--muted); stroke-dasharray: 3 3; stroke-width: 0.8; }
  .foot { margin-top: 0.3rem; }
  .bk { margin-right: 0.6rem; }
  .bk:first-of-type { margin-left: 0.2rem; }
  .once { font-size: 8pt; margin: 0.1rem 0; }
  .gridpage { break-before: page; }
  .h1b { font-size: 12pt; }
  .grid { border-collapse: collapse; font-size: 7.5pt; margin-top: 0.2rem; }
  .grid th, .grid td { padding: 0.02rem 0.4rem; border-bottom: 1px solid var(--border); text-align: center; white-space: nowrap; }
  .grid th.r { text-align: left; font-weight: normal; }
  .grid thead th { color: var(--muted); font-weight: normal; vertical-align: bottom; }
  .grid th.c { max-width: 6rem; white-space: normal; }
  .turn { writing-mode: vertical-rl; transform: rotate(180deg); display: inline-block; max-height: 7rem; overflow: hidden; }
  .cell.fired { font-weight: 700; background: var(--grid); }
  .cell.not-checked { color: var(--muted); }
  .rate { text-align: left !important; color: var(--muted); }
</style>
