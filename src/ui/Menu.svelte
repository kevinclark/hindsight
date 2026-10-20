<!--
  A button that opens a list of actions (WAI-ARIA menu button pattern): aria-haspopup / aria-expanded on the button,
  ArrowDown or Enter opens and focuses the first item (or the checked one), ArrowUp/ArrowDown/Home/End move, Escape
  closes and returns focus to the button, Tab or a click elsewhere closes. Items are at least 28 px tall.
  With `choice`, items are radio items (the checked one is marked) and the button shows the checked item's label.
-->
<script lang="ts">
  import { tick } from 'svelte'
  import { menuTarget } from './menu-keys.ts'

  export interface MenuItem { id: string; label: string; hint?: string; checked?: boolean; onselect: () => void }
  let { label, items, choice = false, align = 'left', title, name }: {
    /** Button text (without the arrow). */
    label: string
    items: MenuItem[]
    choice?: boolean
    align?: 'left' | 'right'
    title?: string
    /** Accessible name when the button text alone is not enough, e.g. "Mode". */
    name?: string
  } = $props()

  let open = $state(false)
  let root: HTMLDivElement
  let button: HTMLButtonElement
  let list: HTMLDivElement | undefined = $state()
  const id = $props.id()

  const entries = () => (list ? [...list.querySelectorAll<HTMLElement>('[role^="menuitem"]')] : [])
  async function show(at: 'first' | 'last' | 'checked' = 'checked') {
    open = true
    await tick()
    const all = entries()
    const checked = all.findIndex((e) => e.getAttribute('aria-checked') === 'true')
    const index = at === 'last' ? all.length - 1 : at === 'checked' && checked >= 0 ? checked : 0
    all[index]?.focus()
  }
  function close(refocus: boolean) {
    open = false
    if (refocus) button?.focus()
  }
  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); show('checked') } else if (e.key === 'ArrowUp') { e.preventDefault(); show('last') }
  }
  function onListKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return }
    if (e.key === 'Tab') { close(false); return }
    const all = entries()
    const next = menuTarget(e.key, all.indexOf(document.activeElement as HTMLElement), all.length)
    if (next !== null) { e.preventDefault(); all[next]?.focus() }
  }
  function pick(item: MenuItem) {
    close(true)
    item.onselect()
  }
</script>

<svelte:window onpointerdown={(e) => { if (open && !root.contains(e.target as Node)) close(false) }} />

<div class="menu" class:right={align === 'right'} bind:this={root} onfocusout={(e) => { if (open && !root.contains(e.relatedTarget as Node | null) && e.relatedTarget) close(false) }}>
  <button bind:this={button} type="button" class="menu-button" class:open aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-label={name ? `${name}: ${label}` : undefined} {title} onclick={() => (open ? close(false) : show('checked'))} onkeydown={onButtonKey}>
    {label}<span class="caret" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="list" id="{id}-list" role="menu" aria-label={name ?? label} tabindex="-1" bind:this={list} onkeydown={onListKey}>
      {#each items as item (item.id)}
        <button type="button" role={choice ? 'menuitemradio' : 'menuitem'} aria-checked={choice ? !!item.checked : undefined} class:checked={item.checked} tabindex="-1" onclick={() => pick(item)}>
          <span>{item.label}</span>{#if item.hint}<small>{item.hint}</small>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu { position: relative; display: inline-block; }
  .menu-button { min-height: 28px; padding: 0.15rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .menu-button:hover, .menu-button.open { border-color: var(--muted); }
  .menu-button:focus-visible, .list button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .caret { margin-left: 0.35rem; font-size: 0.8em; color: var(--muted); }
  .list { position: absolute; z-index: 20; top: calc(100% + 2px); left: 0; display: flex; flex-direction: column; min-width: 100%; width: max-content; max-width: min(22rem, calc(100vw - 3rem)); padding: 0.25rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); }
  .right .list { left: auto; right: 0; }
  .list button { display: flex; flex-direction: column; align-items: flex-start; min-height: 28px; padding: 0.2rem 0.7rem; border: none; border-radius: 4px; background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  .list button:hover { background: var(--hover); }
  .list button.checked { font-weight: 600; }
  .list button.checked span::before { content: '✓ '; color: var(--focus); }
  .list small { color: var(--muted); font-size: 0.78rem; }
  @media print { .menu { display: none; } }
</style>
