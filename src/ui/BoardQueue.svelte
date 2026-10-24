<!-- The queue sheet on screen: the gate reds with a tick each (the tick files the role and time), then the deferrals with their workaround lines. Print gives the two-half sheet (BoardQueuePrint). -->
<script lang="ts">
  import type { QueueSheet } from '../board/sheets.ts'
  import { clockText, ownerText, rowTitle, statusLine } from '../board/words.ts'
  import type { BoardRole } from '../triage/history.ts'
  import type { BoardIssue } from '../board/model.ts'

  let { sheet, role, onBack, onTick }: { sheet: QueueSheet; role: BoardRole | null; onBack: () => void; onTick: (issue: BoardIssue, on: boolean) => void } = $props()
</script>

<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Board</button> · <button type="button" onclick={() => window.print()}>Print this sheet</button></p>
<h3 class="screen">Queue sheet · before {sheet.forLabel}</h3>
<p class="verdict-wrap"><span class="verdict" class:hold={!sheet.verdict.cleared} role="status">{sheet.verdict.text}</span></p>
<p class="sub">{sheet.gate} red{sheet.gate === 1 ? '' : 's'} due before {sheet.forLabel} to confirm (tick with your role, or defer it on the board), then {sheet.deferrals} open deferral{sheet.deferrals === 1 ? '' : 's'} with their workaround lines. Never green: a go still has work open.</p>
{#if !role}<p class="note">Choose your role on the board to tick.</p>{/if}
<ol class="queue">
  {#each sheet.lines as l (l.issue.key)}
    <li>
      {#if l.kind === 'gate'}
        <input type="checkbox" checked={!!l.checked} disabled={!role} aria-label={`Checked: ${rowTitle(l.issue)}`} onchange={(e) => onTick(l.issue, (e.currentTarget as HTMLInputElement).checked)} />
      {:else}<span aria-hidden="true"></span>{/if}
      <div>
        <span class="what">{rowTitle(l.issue)}</span>
        <span class="small muted">{l.kind === 'gate' ? `RED, DUE BEFORE ${sheet.forLabel} · ` : ''}{statusLine(l.issue)} · {ownerText(l.issue)}</span>
        {#if l.kind === 'gate'}<span class="small">{l.issue.nextStep}</span>{/if}
        {#if l.checked}<span class="small"><b>Checked by {l.checked.role} at {clockText(l.checked.when)}</b></span>{:else if l.kind === 'gate'}<span class="small muted">Not checked yet</span>{/if}
        {#if l.kind === 'deferral'}<span class="small"><b>Workaround:</b> {l.issue.deferral?.workaround}</span>{/if}
      </div>
    </li>
  {/each}
</ol>
{#if sheet.lines.length === 0}<p class="muted">Nothing to confirm and no deferrals.</p>{/if}
{#if sheet.more}<p class="small muted">{sheet.more} more on the board.</p>{/if}
