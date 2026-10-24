<!-- The handoff: what the next shift reads before taking over. Reading it files a handoff-read line, which resets "New". -->
<script lang="ts">
  import type { Board } from '../board/model.ts'
  import { handoff } from '../board/sheets.ts'
  import { clockText, ownerText, rowTitle, statusLine } from '../board/words.ts'
  import BoardRow from './BoardRow.svelte'
  import type { BoardRole } from '../triage/history.ts'

  let { board, role, onBack, onOpen, onRead }: { board: Board; role: BoardRole | null; onBack: () => void; onOpen: (key: string) => void; onRead: () => void } = $props()
  const h = $derived(handoff(board))
  const next = $derived(board.tl.next?.label ?? 'the next match')
</script>

<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Board</button></p>
<h3 class="screen">Handoff after {board.tl.last?.label ?? 'the last match'}</h3>
<p class="sub">Next match {next}{board.strip.minutesWord ? `, ${board.strip.minutesWord}` : ''}. Read this whole screen, then say you have.</p>
{#if h.firstRead}<p class="note">No handoff has been read at this event yet, so nothing on the board is marked new. Reading this one starts the count.</p>{/if}

<h4>Reds due before {next} ({h.redsDue.length})</h4>
{#if h.redsDue.length}<ul class="rows">{#each h.redsDue as i (i.key)}<BoardRow issue={i} {onOpen} />{/each}</ul>{:else}<p class="muted">None.</p>{/if}

<h4>Deferrals due before {next} ({h.deferralsDue.length})</h4>
{#if h.deferralsDue.length}
  <ul class="notes">{#each h.deferralsDue as i (i.key)}<li><b>{rowTitle(i)}</b><br /><span class="small">{statusLine(i)}. Workaround for the drive team: {i.deferral?.workaround}</span></li>{/each}</ul>
{:else}<p class="muted">None.</p>{/if}

<h4>What was tried</h4>
{#if h.tried.length}
  <ul class="notes">{#each h.tried as t (t.when + t.text)}<li><b>{t.match ?? 'no match'}</b> · <span class="chip">{t.role}</span> <i>{rowTitle(t.issue)}:</i> {t.text}</li>{/each}</ul>
{:else}<p class="muted">No notes yet on these issues.</p>{/if}
{#if h.ruledOut.length}
  <h5>Ruled out by the logs</h5>
  <ul class="notes">{#each h.ruledOut as r (r.issue.key + r.cause)}<li><i>{rowTitle(r.issue)}:</i> {r.cause} <span class="tag">ruled out</span><br /><span class="small muted">{r.why}</span></li>{/each}</ul>
{/if}

<h4>What we changed in the pit, match by match</h4>
{#if h.pitLines.length}<ul class="notes">{#each h.pitLines as p (p.match)}<li><b>{p.match}</b> · <span class="chip">{p.role}</span> {p.text}</li>{/each}</ul>{:else}<p class="muted">Nothing written yet.</p>{/if}

<h4>New since the last handoff ({h.newSince.length})</h4>
{#if h.newSince.length}<ul class="notes">{#each h.newSince as i (i.key)}<li><b>{rowTitle(i)}</b> · {statusLine(i)} · <span class="chip" class:none={!i.owner}>{ownerText(i)}</span></li>{/each}</ul>{:else}<p class="muted">Nothing new.</p>{/if}

<div class="bigcard">
  {#if board.handoff}<p>Last read by <span class="chip">{board.handoff.role}</span> after {board.handoff.match || 'the first match'} ({clockText(board.handoff.when)}).</p>{/if}
  <p><b>Before you take over:</b> you have read the reds due before the next match, the deferrals due and what was tried.</p>
  <button type="button" class="primary" disabled={!role} onclick={onRead}>I've read this{role ? ` (as ${role})` : ''}</button>
  {#if !role}<span class="small muted"> Choose your role on the board first.</span>{/if}
</div>
