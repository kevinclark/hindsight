<script lang="ts">
  // The one text dialog (see ask-text.svelte.ts). A native <dialog>: modal, traps focus, Escape fires `cancel`.
  import { asking } from './ask-text.svelte.ts'

  let dialog: HTMLDialogElement | undefined = $state()
  let input: HTMLInputElement | undefined = $state()
  let value = $state('')
  const req = $derived(asking())

  // Each new question (the reason loop asks again at once) starts from its own text and puts the cursor back in the field.
  let shown: unknown = null
  $effect(() => {
    if (req && dialog) {
      if (!dialog.open) dialog.showModal()
      if (shown !== req) { shown = req; value = req.initial; input?.focus(); input?.select() }
    } else if (!req && dialog?.open) { shown = null; dialog.close() }
  })

  function submit(e: SubmitEvent) {
    e.preventDefault()
    req?.resolve(value)
  }
  function cancel(e: Event) {
    e.preventDefault() // we close it ourselves, after the answer is out
    req?.resolve(null)
  }
</script>

<dialog bind:this={dialog} oncancel={cancel} aria-labelledby="ask-text-label">
  {#if req}
    <form onsubmit={submit}>
      <label id="ask-text-label" for="ask-text-input">{req.question}</label>
      <input id="ask-text-input" type="text" bind:this={input} bind:value autocomplete="off" />
      <div class="row">
        <button type="button" onclick={() => req.resolve(null)}>Cancel</button>
        <button type="submit" class="ok">OK</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog { width: min(34rem, calc(100vw - 2rem)); padding: 1rem; border: 1px solid var(--muted); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { overflow-wrap: anywhere; }
  input { min-height: 28px; padding: 0.3rem 0.5rem; border: 1px solid var(--muted); border-radius: 4px; background: var(--bg); color: var(--fg); font: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .row { display: flex; justify-content: flex-end; gap: 0.5rem; }
  button { min-width: 24px; min-height: 28px; padding: 0.3rem 0.9rem; border: 1px solid var(--muted); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  button.ok { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
</style>
