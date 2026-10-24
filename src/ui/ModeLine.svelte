<!--
  The mode line (ADR 3: always shown, one click to change). One persistent line in the verdict header of Match review, the
  Session view and Foresight, never a toast, and one control beside it to change the mode for that session. Nothing here
  decides the mode: the caller words it (src/session/mode.ts) and keeps the choice (session-names.svelte.ts).
-->
<script lang="ts">
  import type { Mode } from '../session/mode.ts'

  let { text, mode, byHand, onChange, hint }: { text: string; mode: Mode; byHand: boolean; onChange: (mode: Mode | null) => void; hint?: string } = $props()
</script>

<p class="mode-line" data-mode-line>
  <span data-mode-text>{text}</span>{' '}
  <label>Mode: <select aria-label="Mode for this session" title={hint} value={mode} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; onChange(v === 'auto' ? null : (v as Mode)) }}>
    <option value="event">Event</option>
    <option value="practice">Practice</option>
    {#if byHand}<option value="auto">Automatic (from the logs)</option>{/if}
  </select></label>{#if hint}{' '}<span class="hint">{hint}</span>{/if}
</p>

<style>
  .mode-line { margin: 0.25rem 0; font-size: 0.85rem; color: var(--muted); }
  .hint { display: block; }
  [data-mode-text] { color: var(--fg); font-weight: 600; }
  select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; min-height: 24px; box-sizing: border-box; }
</style>
