<!-- The handoff: what the next shift reads before taking over. Reading it files a handoff-read line, which resets "New". -->
<script lang="ts">
  import type { Board } from '../board/model.ts'
  import { handoff } from '../board/sheets.ts'
  import { clockText, ownerText, rowTitle, statusLine } from '../board/words.ts'
  import BoardRow from './BoardRow.svelte'
  import { CAUSE_TAGS } from '../board/debug.ts'
  import type { BoardIssue } from '../board/model.ts'
  import type { BoardRole } from '../triage/history.ts'

  let { board, role, onBack, onOpen, onRead }: { board: Board; role: BoardRole | null; onBack: () => void; onOpen: (key: string) => void; onRead: () => void } = $props()
  const h = $derived(handoff(board))
  // Sections with nothing in them fold into one line.
  const empty = $derived([h.deferralsDue.length ? '' : 'deferrals due', h.tried.length ? '' : 'what was tried', h.pitLines.length ? '' : 'pit changes', h.newSince.length ? '' : 'new since the last handoff'].filter(Boolean))
  const next = $derived(board.tl.next?.label ?? 'the next match')
</script>

<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Board</button></p>
<h3 class="screen">Handoff after {board.tl.last?.label ?? 'the last match'}</h3>
<p class="sub">{board.tl.next ? `Next match ${next}` : 'No next match named yet (no schedule)'}{board.strip.minutesWord ? `, ${board.strip.minutesWord}` : ''}. Read this whole screen, then say you have.{#if h.firstRead}{' '}No handoff has been read at this event yet, so nothing is marked new; reading this one starts the count.{/if}</p>

{#snippet lines(i: BoardIssue)}
  {#each h.causeLines.get(i.key) ?? [] as c (c.kind + c.cause + c.by)}
    <p class="causeline small"><span class="tag">{CAUSE_TAGS[c.kind]}</span>{' '}{c.cause}{#if c.by === 'logs'}{' '}<span class="tag">by Hindsight's evidence</span>{:else if c.role}{' '}<span class="chip">{c.role}</span>{/if}{#if c.text}<br /><span class="muted">{c.kind === 'ruled-out' && c.by === 'team' ? `Ruled out by ${c.text}` : c.text}</span>{/if}</p>
  {/each}
{/snippet}

<h4>Reds due before {next} ({h.redsDue.length})</h4>
{#if h.redsDue.length}<ul class="rows">{#each h.redsDue as i (i.key)}<BoardRow issue={i} {onOpen} />{#if h.causeLines.get(i.key)?.length}<li class="readback">{@render lines(i)}</li>{/if}{/each}</ul>{:else}<p class="muted">None.</p>{/if}

{#if h.deferralsDue.length}
  <h4>Deferrals due before {next} ({h.deferralsDue.length})</h4>
  <ul class="notes">{#each h.deferralsDue as i (i.key)}<li><b>{rowTitle(i)}</b><br /><span class="small">{statusLine(i)}. Workaround for the drive team: {i.deferral?.workaround}</span>{@render lines(i)}</li>{/each}</ul>
{/if}

{#if h.tried.length}
  <h4>What was tried</h4>
  <ul class="notes">{#each h.tried as t (t.when + t.text)}<li><b>{t.match ?? 'no match'}</b> · <span class="chip">{t.role}</span> <i>{rowTitle(t.issue)}:</i> {t.text}</li>{/each}</ul>
{/if}

{#if h.pitLines.length}
  <h4>What we changed in the pit, match by match</h4>
  <ul class="notes">{#each h.pitLines as p (p.match)}<li><b>{p.match}</b> · <span class="chip">{p.role}</span> {p.text}</li>{/each}</ul>
{/if}

{#if h.newSince.length}
  <h4>New since the last handoff ({h.newSince.length})</h4>
  <ul class="notes">{#each h.newSince as i (i.key)}<li><b>{rowTitle(i)}</b> · {statusLine(i)} · <span class="chip" class:none={!i.owner}>{ownerText(i)}</span></li>{/each}</ul>
{/if}

{#if empty.length}<p class="muted">Nothing yet for: {empty.join(', ')}.</p>{/if}

<div class="bigcard">
  {#if board.handoff}<p>Last read by <span class="chip">{board.handoff.role}</span> after {board.handoff.match || 'the first match'} ({clockText(board.handoff.when)}).</p>{/if}
  <p><b>Before you take over:</b> you have read the reds due before the next match, the deferrals due and what was tried.</p>
  <button type="button" class="primary" disabled={!role} onclick={onRead}>I've read this{role ? ` (as ${role})` : ''}</button>
  {#if !role}<span class="small muted"> Choose your role on the board first.</span>{/if}
</div>
