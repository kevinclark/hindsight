<!--
  The printed queue sheet: hidden on screen, the only thing printed while the queue sheet is open. One page in two halves with a
  cut line between: the top for the drive team (the verdict word with its counts, the workaround lines), the bottom for the pit
  (the gate reds, a tick each with the role and time written in, and what to do). The split is a UX-review prediction, not tested.
  Words and shapes carry everything (never colour alone); it is always light.
-->
<script lang="ts">
  import type { QueueSheet } from '../board/sheets.ts'
  import { clockText, rowTitle } from '../board/words.ts'

  let { sheet, title }: { sheet: QueueSheet; title: string } = $props()
  const gate = $derived(sheet.lines.filter((l) => l.kind === 'gate'))
  const defs = $derived(sheet.lines.filter((l) => l.kind === 'deferral'))
</script>

<article class="print-only queue-sheet" aria-hidden="true">
  <section class="half">
    <p class="who">For the drive team · {title} · before {sheet.forLabel}</p>
    <p class="verdict" class:hold={!sheet.verdict.cleared}>{sheet.verdict.text}</p>
    <p class="counts">{sheet.gate} red{sheet.gate === 1 ? '' : 's'} due before {sheet.forLabel} · {sheet.deferrals} deferral{sheet.deferrals === 1 ? '' : 's'} · {sheet.redsOpen} red{sheet.redsOpen === 1 ? '' : 's'} open. A go still has work open.</p>
    {#if defs.length}
      <ol>{#each defs as l (l.issue.key)}<li><b>{rowTitle(l.issue)}</b><br />Workaround: {l.issue.deferral?.workaround}<br /><span class="small">Until {l.issue.deferral?.point.until}</span></li>{/each}</ol>
    {:else}<p>No workarounds in force.</p>{/if}
  </section>
  <p class="cut">✂ - - - - - - - - - - - - - - - - - cut here - - - - - - - - - - - - - - - - -</p>
  <section class="half">
    <p class="who">For the pit · before {sheet.forLabel}</p>
    {#if gate.length}
      <ol>{#each gate as l (l.issue.key)}
        <li><span class="box" aria-hidden="true">{l.checked ? '☑' : '☐'}</span> <b>{rowTitle(l.issue)}</b> <span class="small">(red, due before {sheet.forLabel})</span><br />{l.issue.nextStep}<br />
          <span class="small">{l.checked ? `Checked by ${l.checked.role} at ${clockText(l.checked.when)}` : 'Checked by ________ (role) at ________ (time)'}</span></li>
      {/each}</ol>
    {:else}<p>No reds to confirm.</p>{/if}
    {#if sheet.more}<p class="small">{sheet.more} more on the board.</p>{/if}
  </section>
</article>

<style>
  .print-only { display: none; }
  @media print {
    .print-only { display: block; color: #1d1d1f; background: #fff; font: 12pt/1.35 system-ui, sans-serif; }
    .half { height: 4.6in; overflow: hidden; break-inside: avoid; }
    .who { font-weight: 700; margin: 0 0 0.3rem; }
    .verdict { display: inline-block; border: 3pt solid #1d1d1f; padding: 0.2rem 0.8rem; font-size: 20pt; font-weight: 800; margin: 0.2rem 0; }
    .verdict.hold { border-style: double; }
    .counts { margin: 0.2rem 0 0.5rem; }
    ol { padding-left: 1.3rem; margin: 0.2rem 0; }
    li { margin: 0.4rem 0; }
    .box { font-size: 16pt; }
    .small { font-size: 10pt; }
    .cut { text-align: center; color: #5f6368; margin: 0.3rem 0; }
  }
</style>
