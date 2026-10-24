<!-- Missed by Hindsight: one line, filed for the review after the event (an event-note line); nothing on the board changes. -->
<script lang="ts">
  import type { Board } from '../board/model.ts'
  import { clockText } from '../board/words.ts'
  import type { BoardRole } from '../triage/history.ts'

  let { board, role, onBack, onFile }: { board: Board; role: BoardRole | null; onBack: () => void; onFile: (text: string) => void } = $props()
  let text = $state('')
</script>

<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Board</button></p>
<h3 class="screen">Missed by Hindsight</h3>
<p class="sub">What did the team find that Hindsight didn't? One line. It is filed for the review after the event; nothing changes on the board.</p>
<div class="field">
  <label for="board-missed">What did we find that Hindsight didn't?</label>
  <input id="board-missed" type="text" bind:value={text} placeholder="e.g. the intake roller squeals before it stalls" onkeydown={(e) => { if (e.key === 'Enter' && role && text.trim()) { onFile(text.trim()); text = '' } }} />
</div>
<button type="button" class="primary" disabled={!role || !text.trim()} onclick={() => { onFile(text.trim()); text = '' }}>File it{role ? ` as ${role}` : ''}</button>
{#if !role}<span class="small muted"> Choose your role on the board first.</span>{/if}
<div role="status">
  {#if board.missed.length}
    <p class="flash">Filed for after the event. {board.missed.length} line{board.missed.length === 1 ? '' : 's'} filed so far.</p>
    <ul class="notes">{#each board.missed as m (m.when + m.text)}<li>{clockText(m.when)} · <span class="chip">{m.role}</span> {m.text}</li>{/each}</ul>
  {/if}
</div>
