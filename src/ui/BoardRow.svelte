<!-- One row of the board: the priority word (shape and word, never colour alone), mechanism · rule, status, due, one action, the owner alone. -->
<script lang="ts">
  import { seenText, type BoardIssue } from '../board/model.ts'
  import { changedLine, clockText, dueLine, ownerText, priorityIcon, priorityWord, rowTitle, statusLine, tags } from '../board/words.ts'

  let { issue, onOpen, role = null, onGrey, onHolds }: {
    issue: BoardIssue; onOpen: (key: string) => void; role?: string | null; onGrey?: (issue: BoardIssue, what: 'close' | 'take') => void
    /** After the playoff cut-off (ADR 7): a tick that the open deferral still holds. Given only then. */
    onHolds?: (issue: BoardIssue, on: boolean) => void
  } = $props()
  const askHolds = $derived(!!onHolds && issue.status === 'deferred' && !!issue.deferral && !issue.deferral.expired)
  const fresh = $derived(issue.holds && !issue.holds.old ? issue.holds : null)
</script>

<li>
  <button type="button" class="row" class:grey={issue.grey} data-issue={issue.key} onclick={() => onOpen(issue.key)}>
    <span class={`sev ${issue.grey || issue.status === 'deferred' ? 'grey' : issue.priority}`}><span aria-hidden="true">{priorityIcon(issue)}</span>{' '}{priorityWord(issue)}{#if issue.grey}<span class="small muted">{issue.unchanged} matches unchanged</span>{:else if issue.status === 'deferred'}<span class="small muted">deferred</span>{/if}</span>
    <span class="main">
      <span class="title">{rowTitle(issue)}</span>{#each tags(issue) as t (t)}<span class="tag">{t}</span>{/each}
      {#if issue.nextStep}<span class="verb">{issue.nextStep}</span>{/if}
      <span class="changed">{seenText(issue.seenIn)} · {changedLine(issue)}</span>
    </span>
    <span class="status">{#if issue.status === 'deferred' && issue.deferral}Workaround until {issue.deferral.point.until}<span class="due">re-decide {issue.deferral.point.redecide}</span>{:else}{statusLine(issue)}{#if dueLine(issue)}<span class="due">{dueLine(issue)}</span>{/if}{/if}</span>
    <span class="owner"><span class="chip" class:none={!issue.owner}>{ownerText(issue)}</span></span>
  </button>
  {#if askHolds}
    <p class="holds" data-holds>
      <label><input type="checkbox" checked={!!fresh} disabled={!role && !fresh} aria-label={`Still holds: ${rowTitle(issue)}`} onchange={(e) => onHolds?.(issue, (e.currentTarget as HTMLInputElement).checked)} />{' '}Still holds?</label>{' '}
      {#if fresh}<b>Still holds, ticked by {fresh.role} at {clockText(fresh.when)}</b>{:else if issue.holds?.old}<span class="muted">ticked by {issue.holds.role} at {clockText(issue.holds.when)} ({issue.holds.ahead ? 'clock ahead' : 'old'}): tick again</span>{:else}<span class="muted">not asked yet</span>{/if}
    </p>
  {/if}
  {#if issue.greyAsk}
    <p class="greyask">{issue.greyAsk}{' '}
      <button type="button" disabled={!role || !onGrey} title={role ? '' : 'Choose your role first'} onclick={() => onGrey?.(issue, 'close')}>Close</button>{' '}
      <button type="button" disabled={!role || !onGrey} title={role ? '' : 'Choose your role first'} onclick={() => onGrey?.(issue, 'take')}>Give it an owner</button></p>
  {/if}
</li>

<style>
  .holds { margin: 0; padding: 0.15rem 0.6rem 0.3rem; font-size: 0.85rem; border-left: 4px solid var(--border); }
  .holds label { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 24px; }
  .holds input { width: 24px; height: 24px; margin: 0; }
  .holds .muted { color: var(--muted); }
</style>
