<!-- Choose a Drive folder: browse (My Drive and shared drives) or paste a link or id. Shown inline, under the button that opened it. -->
<script lang="ts">
  import type { HubApi } from '../hub/bridge.ts'

  let { api, label, onPick, onCancel }: { api: HubApi; label: string; onPick: (idOrLink: string) => void; onCancel: () => void } = $props()

  let trail = $state<{ id: string; name: string }[]>([{ id: 'roots', name: 'Drive' }])
  let choices = $state.raw<{ id: string; name: string }[]>([])
  let pasted = $state('')
  let problem = $state<string | null>(null)
  let busy = $state(false)

  const here = $derived(trail[trail.length - 1])
  $effect(() => {
    const id = here.id
    busy = true
    problem = null
    api.driveFolders(id).then((c) => { if (id === here.id) choices = c }).catch((e) => { problem = String(e.message ?? e) }).finally(() => { busy = false })
  })
</script>

<div class="picker" role="group" aria-label={label}>
  <p class="path">{#each trail as t, i (t.id)}{#if i > 0}{' › '}{/if}<button class="link" onclick={() => (trail = trail.slice(0, i + 1))}>{t.name}</button>{/each}</p>
  {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
  <ul>
    {#each choices as c (c.id)}<li><button class="link" onclick={() => (trail = [...trail, c])}>{c.name}</button></li>{:else}<li class="meta">{busy ? 'Looking…' : 'No folders here.'}</li>{/each}
  </ul>
  <div class="row">
    <button class="primary" disabled={here.id === 'roots'} onclick={() => onPick(here.id)}>{label}: {here.name}</button>
    <span class="meta">or paste a link</span>
    <input bind:value={pasted} placeholder="https://drive.google.com/drive/folders/…" />
    <button class="primary" disabled={!pasted.trim()} onclick={() => onPick(pasted)}>Use it</button>
    <button class="link" onclick={onCancel}>Cancel</button>
  </div>
</div>

<style>
  .picker { border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.75rem; margin: 0.5rem 0; max-width: 46rem; }
  .path { margin: 0 0 0.25rem; font-size: 0.85rem; }
  ul { list-style: none; margin: 0 0 0.5rem; padding: 0; max-height: 12rem; overflow: auto; columns: 2; font-size: 0.85rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.4rem 0.6rem; align-items: center; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .problem { color: var(--error); margin: 0.25rem 0; }
  input { flex: 1; min-width: 12rem; font: inherit; font-size: 0.85rem; min-height: 24px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.3rem; }
  button { font: inherit; color: var(--fg); }
  .primary { padding: 0.25rem 0.7rem; border: 1px solid var(--focus); border-radius: 6px; background: none; cursor: pointer; }
  .primary:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
  .link { border: none; background: none; color: var(--fg); text-decoration: underline; cursor: pointer; min-height: 24px; padding: 0 0.2rem; }
</style>
