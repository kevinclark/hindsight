<script lang="ts">
  // The "what's inside" list shown before a file for Claude is saved (see export-preview.svelte.ts). A native <dialog>, like AskText.
  import { exporting } from './export-preview.svelte.ts'

  let dialog: HTMLDialogElement | undefined = $state()
  let save: HTMLButtonElement | undefined = $state()
  const req = $derived(exporting())

  $effect(() => {
    if (req && dialog) {
      if (!dialog.open) { dialog.showModal(); save?.focus() }
    } else if (!req && dialog?.open) dialog.close()
  })
  function cancel(e: Event) {
    e.preventDefault()
    req?.resolve(false)
  }
</script>

<dialog bind:this={dialog} oncancel={cancel} aria-labelledby="export-preview-title" data-export-preview>
  {#if req}
    <h2 id="export-preview-title">Inside {req.fileName}</h2>
    <p class="lead">This file is saved on this laptop. It leaves only if you upload it to an assistant.</p>
    <ul>{#each req.lines as l (l)}<li>{l}</li>{/each}</ul>
    <div class="row">
      <button type="button" onclick={() => req.resolve(false)}>Cancel</button>
      <button type="button" class="ok" bind:this={save} onclick={() => req.resolve(true)}>Save</button>
    </div>
  {/if}
</dialog>

<style>
  dialog { width: min(36rem, calc(100vw - 2rem)); padding: 1rem 1.2rem; border: 1px solid var(--muted); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
  h2 { font-size: 1.1rem; margin: 0 0 0.4rem; overflow-wrap: anywhere; }
  .lead { margin: 0 0 0.5rem; color: var(--muted); font-size: 0.9rem; }
  ul { margin: 0.3rem 0 0.8rem; padding-left: 1.2rem; }
  li { margin: 0.25rem 0; }
  .row { display: flex; justify-content: flex-end; gap: 0.5rem; }
  button { min-width: 24px; min-height: 28px; padding: 0.3rem 0.9rem; border: 1px solid var(--muted); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  button.ok { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
