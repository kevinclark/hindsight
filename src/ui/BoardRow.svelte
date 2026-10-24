<!-- One row of the board: the priority word (shape and word, never colour alone), mechanism · rule, status, due, one action, the owner alone. -->
<script lang="ts">
  import type { BoardIssue } from '../board/model.ts'
  import { changedLine, dueLine, ownerText, priorityIcon, priorityWord, rowTitle, statusLine, tags } from '../board/words.ts'

  let { issue, onOpen, role = null, onGrey }: { issue: BoardIssue; onOpen: (key: string) => void; role?: string | null; onGrey?: (issue: BoardIssue, what: 'close' | 'take') => void } = $props()
</script>

<li>
  <button type="button" class="row" class:grey={issue.grey} data-issue={issue.key} onclick={() => onOpen(issue.key)}>
    <span class={`sev ${issue.grey || issue.status === 'deferred' ? 'grey' : issue.priority}`}><span aria-hidden="true">{priorityIcon(issue)}</span>{' '}{priorityWord(issue)}{#if issue.grey}<span class="small muted">{issue.unchanged} matches unchanged</span>{:else if issue.status === 'deferred'}<span class="small muted">deferred</span>{/if}</span>
    <span class="main">
      <span class="title">{rowTitle(issue)}</span>{#each tags(issue) as t (t)}<span class="tag">{t}</span>{/each}
      {#if issue.nextStep}<span class="verb">{issue.nextStep}</span>{/if}
      <span class="changed">Seen in {issue.seenIn.n} of {issue.seenIn.of} match{issue.seenIn.of === 1 ? '' : 'es'} · {changedLine(issue)}</span>
    </span>
    <span class="status">{#if issue.status === 'deferred' && issue.deferral}Workaround until {issue.deferral.point.until}<span class="due">re-decide {issue.deferral.point.redecide}</span>{:else}{statusLine(issue)}{#if dueLine(issue)}<span class="due">{dueLine(issue)}</span>{/if}{/if}</span>
    <span class="owner"><span class="chip" class:none={!issue.owner}>{ownerText(issue)}</span></span>
  </button>
  {#if issue.greyAsk}
    <p class="greyask">{issue.greyAsk}{' '}
      <button type="button" disabled={!role || !onGrey} title={role ? '' : 'Choose your role first'} onclick={() => onGrey?.(issue, 'close')}>Close</button>{' '}
      <button type="button" disabled={!role || !onGrey} title={role ? '' : 'Choose your role first'} onclick={() => onGrey?.(issue, 'take')}>Give it an owner</button></p>
  {/if}
</li>
