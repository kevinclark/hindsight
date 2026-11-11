<!-- The line shown while a log downloads to the phone: what, how much of how much, a <progress> and Stop. Shared by the Library
     and by Match review's "Full review" button, so the two read alike. -->
<script lang="ts">
  import { mb } from './phone-library.ts'

  let { name, got, total, onStop }: { name: string; got: number; total: number; onStop: () => void } = $props()
</script>

<div class="opening" role="status">
  <p>Downloading {name}: {mb(got)} of {mb(total)} MB</p>
  <progress max={total} value={got}></progress>
  <button onclick={onStop}>Stop</button>
</div>

<style>
  .opening { position: sticky; top: 0; background: var(--bg); padding: 0.5rem 0; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; z-index: 1; }
  .opening p { margin: 0; flex-basis: 100%; }
  progress { flex: 1; }
  button { font: inherit; color: var(--fg); background: none; border: 1px solid var(--focus); border-radius: 6px; padding: 0.3rem 0.7rem; white-space: nowrap; cursor: pointer; }
</style>
