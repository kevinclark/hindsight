<!--
  Foresight's practice-start checklist (ADR 9, practice mode): read-do. The team's pit checklist in a fixed order (battery,
  CAN, cameras, zeros, then the rest of the live checks), each line Done or Left, ending "Ready to drive" or "n left: …".
  No Go verdict: this is a start-up list, not a gate. The end line is also in Foresight's big box above.
-->
<script lang="ts">
  import type { PracticeChecklist } from '../foresight/checklists.ts'

  let { checklist }: { checklist: PracticeChecklist } = $props()
  const MARK = { ok: 'Done', red: 'Left: fix', amber: 'Left: look', 'to do': 'Left: do', context: 'Context', 'not checked': 'Left: not checked', 'by eye': 'By eye' } as const
</script>

<section class="onchecks practice" aria-label="Practice-start checklist">
  <h3>Practice-start checklist: read each line, do it, then it reads Done</h3>
  <ul>
    {#each checklist.items as i, n (i.line.line)}
      {#if n === 0 || checklist.items[n - 1].group !== i.group}<li class="group" aria-hidden="true">{i.group}</li>{/if}
      <li class={`oc ${i.line.state.replace(' ', '-')}`}><span class="mark">{i.done ? '✓ ' : '○ '}{MARK[i.line.state]}</span><span class="line">{i.line.line}</span><span class="detail-text">{i.line.detail}</span></li>
    {/each}
  </ul>
  <p class="end" class:ready={checklist.ready} role="status">{checklist.end}</p>
  <p class="small">The team's 2026 pit checklist, battery, CAN, cameras and zeros first. A line reads Done only from the check on screen now; "By eye" lines are for a person and are never counted.</p>
  {#if checklist.byEye.length}
    <details class="inert">
      <summary>{checklist.byEye.length} lines for a person or context: never counted</summary>
      <ul>
        {#each checklist.byEye as l (l.line)}<li class={`oc ${l.state.replace(' ', '-')}`}><span class="mark">{MARK[l.state]}</span><span class="line">{l.line}</span><span class="detail-text">{l.detail}</span></li>{/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  .onchecks { margin-top: 1rem; }
  .onchecks h3 { font-size: 1rem; margin: 0 0 0.4rem; }
  .onchecks ul { list-style: none; margin: 0; padding: 0; }
  .group { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); padding: 0.5rem 0 0.1rem; }
  .oc { display: grid; grid-template-columns: 9.5rem minmax(10rem, 1fr) 2fr; gap: 0.15rem 0.75rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; align-items: baseline; }
  .oc .mark { font-weight: 700; font-size: 0.8rem; }
  .oc.ok .mark { color: var(--muted); font-weight: 400; }
  .oc.not-checked .mark { color: var(--fg); }
  .oc.red .mark { color: var(--error); }
  .oc.amber .mark { color: var(--warning); }
  .oc.to-do .mark { color: var(--fg); }
  .oc .detail-text { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  @media (max-width: 600px) { .oc { grid-template-columns: 8rem 1fr; } .oc .detail-text { grid-column: 2; } }
  .end { margin: 0.6rem 0 0.2rem; font-size: 1.15rem; font-weight: 700; overflow-wrap: anywhere; }
  .end.ready { color: var(--go, #188038); }
  .small { font-size: 0.8rem; color: var(--muted); }
  .inert { margin-top: 0.4rem; }
  .inert summary { color: var(--muted); font-size: 0.85rem; cursor: pointer; padding: 0.25rem 0; min-height: 24px; box-sizing: border-box; }
  .oc.context .mark, .oc.by-eye .mark { color: var(--muted); }
</style>
