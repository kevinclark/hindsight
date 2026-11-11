<!-- The phone's Library: every robot log the team's laptops have shared to Drive, newest day first: matches and on-checks as rows,
     the other off-the-field logs folded, the laptop's filters behind one button. Opening one downloads it (and its Driver Station
     logs) to this phone for Match review. -->
<script lang="ts">
  import type { BrowserHub, OpenedFile } from '../hub/browser-hub.ts'
  import type { Entry } from '../hub/catalog.ts'
  import { FACET_LABELS, UNKNOWN, countLabel, facetCounts, facetValues, filterEntries, robotLabels, type FacetId, type Selection } from '../hub/facets.ts'
  import { eventPlaces } from '../hub/event-places.ts'
  import { activeLine, dayItems, isLarge, mb, onThisPhone, rowParts, sheetFacets, sizeOf, whenOf } from './phone-library.ts'
  import OpenProgress from './OpenProgress.svelte'
  import { tick } from 'svelte'
  import { KEEP_CHOICES, keepCap, setKeepCap } from '../phone/keep-setting.ts'

  /** `onOpening`: before a download starts, so the log held now can be let go first (one log in memory at a time). */
  let { hub, onOpening, onOpen, onBusy }: { hub: BrowserHub; onOpening: () => void; onOpen: (files: OpenedFile[]) => void; onBusy?: (busy: boolean) => void } = $props()

  let entries = $state.raw<Entry[] | null>(null)
  /** sha-256 of the logs kept on this phone (opening one reads no Drive bytes). */
  let kept = $state.raw<Set<string>>(new Set())
  let keptBytes = $state(0)
  let cap = $state(keepCap(localStorage))
  const refreshKept = async () => { try { kept = await hub.keptLogs(); keptBytes = await hub.keptBytes() } catch { /* shown as not kept */ } }
  async function chooseCap(bytes: number) {
    cap = bytes
    setKeepCap(localStorage, bytes)
    await hub.setKeepCap(bytes)
    await refreshKept()
  }
  async function clearKept() { await hub.clearKept(); await refreshKept() }
  /** The list could not be read: its line and its Try again (list again). */
  let problem = $state<string | null>(null)
  /** An open failed: shown in the sticky slot the download progress uses, so it is seen wherever the list is scrolled, with a Try again for that same log. */
  let openError = $state.raw<{ entry: Entry; why: string } | null>(null)
  let selection = $state<Selection>({})
  let sheetOpen = $state(false)
  let filtersButton = $state<HTMLButtonElement>()
  let sheetEl = $state<HTMLDivElement>()
  /** The sheet is a modal dialog: focus goes into it, Escape closes it, the page behind keeps still, and focus returns to the button that opened it. */
  $effect(() => {
    if (!sheetOpen) return
    const scrollBefore = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    void tick().then(() => sheetEl?.focus())
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeSheet() } }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = scrollBefore }
  })
  function closeSheet() { sheetOpen = false; void tick().then(() => filtersButton?.focus()) }
  let folds = $state<Record<string, boolean>>({})
  // Raw, and told apart by a number: a $state object would wrap `entry` in a proxy, so `opening.entry === entry` never
  // held, progress never showed, and the line never cleared (seen on the phone, 2026-11-09).
  let opening = $state.raw<{ id: number; entry: Entry; got: number; total: number; stop: AbortController } | null>(null)
  let opens = 0
  $effect(() => { onBusy?.(!!opening) })
  /** Stop the download in flight, if any (Match review's own open is starting or a match was picked). */
  export function stop() { opening?.stop.abort() }

  async function list() {
    problem = null
    void refreshKept()
    try { entries = await hub.logs() } catch (e) { problem = `Could not list the team's logs (${e instanceof Error ? e.message : String(e)}).` }
  }
  void list()

  let onlyHere = $state(false)
  const all = $derived(entries ?? [])
  /** Decided over every log, like the laptop's Library: a filter never renames a robot or an event. The phone has no TBA lookup, so the places are the ones the log days give. */
  const labels = $derived(robotLabels(all))
  const places = $derived(eventPlaces(all, new Map()))
  const base = $derived(onlyHere ? onThisPhone(all, kept) : all)
  const shown = $derived(filterEntries(base, selection, labels, places))
  const counts = $derived(facetCounts(base, selection, labels, places))
  const picks = $derived(activeLine(selection, shown.length, base.length))
  const days = $derived(dayItems(shown))
  /** The event each log belongs to, named on its row only when the visible rows differ. */
  const placeOf = (e: Entry) => facetValues(e, labels, places).place
  const mixedEvents = $derived(new Set(shown.map(placeOf)).size > 1)
  const nothingKept = $derived(onlyHere && onThisPhone(all, kept).length === 0)
  function toggle(f: FacetId, value: string) {
    const now = selection[f] ?? []
    selection = { ...selection, [f]: now.includes(value) ? now.filter((v) => v !== value) : [...now, value] }
  }
  /** A fold is told apart by its first log, so it keeps its open state when the list above it changes. */
  const foldKey = (entries: Entry[]) => entries[0].record.sha256
  const sheet = $derived(sheetFacets(counts, selection))
  /** The row's name in an error: "Q1", or "On-check at 9:49 AM" for a log with no match number. */
  const rowName = (e: Entry) => { const p = rowParts(e); return p.bold || !p.when ? p.label : `${p.label} at ${p.when}` }

  /** Each step to the app's console (Xcode, `devicectl … launch --console`): a download that hangs shows where. */
  const say = (line: string) => console.log(`Hindsight Library: ${line}`)

  async function open(entry: Entry) {
    const stop = new AbortController()
    onOpening()
    const id = ++opens
    opening = { id, entry, got: 0, total: sizeOf(entry), stop }
    problem = null
    openError = null
    try {
      const files = await hub.openLog(entry, { signal: stop.signal, log: say, onProgress: (got, total) => { if (opening?.id === id) opening = { ...opening, got, total } } })
      say('downloaded; opening in Match review')
      void refreshKept()
      onOpen(files)
    } catch (e) {
      say(`ended: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      if (!stop.signal.aborted) openError = { entry, why: e instanceof Error ? e.message : String(e) }
    } finally { if (opening?.id === id) opening = null }
  }
</script>

<section class="phone-library">
  {#if problem}<p class="problem" role="alert">{problem} <button class="link" onclick={list}>Try again</button></p>{/if}
  {#if opening}
    <div class="sticky"><OpenProgress name={opening.entry.record.names[0]} got={opening.got} total={opening.total} onStop={() => { say('Stop pressed'); opening?.stop.abort() }} /></div>
  {:else if openError}
    <div class="sticky error"><p class="problem" role="alert">Couldn't open {rowName(openError.entry)}: {openError.why} <button class="link retry" onclick={() => open(openError!.entry)}>Try again</button></p></div>
  {/if}
  {#if entries === null}
    {#if !problem}<p class="meta">Reading the team's list of logs…</p>{/if}
  {:else if entries.length === 0}
    <p class="meta">No laptop has shared logs to the team Drive yet: they go up when a laptop syncs.</p>
  {:else}
    <div class="bar">
      <button class="filters" bind:this={filtersButton} aria-haspopup="dialog" onclick={() => (sheetOpen = true)}>Filters</button>
      <label class="here"><input type="checkbox" bind:checked={onlyHere} /> Only on this phone</label>
    </div>
    {#if picks}<p class="picks"><span>{picks}</span> <button class="clear" onclick={() => (selection = {})}>Clear</button></p>{/if}
    {#if nothingKept}<p class="meta">No logs are kept on this phone yet: open one and it stays here.</p>{/if}
    {#each days as d (d.day)}
      <h3>{d.heading}</h3>
      <ul>
        {#each d.items as item (item.type === 'fold' ? `fold:${foldKey(item.entries)}` : item.entries[0].record.sha256)}
          {#if item.type === 'fold'}
            {@const k = foldKey(item.entries)}
            <li class="fold"><button class="foldline" aria-expanded={!!folds[k]} onclick={() => (folds = { ...folds, [k]: !folds[k] })}>
              <span class="caret" aria-hidden="true">{folds[k] ? '▾' : '▸'}</span> {item.text}</button></li>
            {#if folds[k]}
              {#each item.entries as e (e.record.sha256)}{@render logRow([e], true)}{/each}
            {/if}
          {:else}
            {@render logRow(item.entries, item.muted)}
          {/if}
        {/each}
      </ul>
    {/each}
  {/if}
  <p class="meta explain">Every robot log your team's laptops have shared. Opening one downloads it to this phone (the size is on the button) and shows its full Match review. The ones you opened last stay on this phone (reopening needs no download) until Sign out.</p>
  <p class="keep"><label>Keep opened logs: <select value={cap} onchange={(e) => chooseCap(Number((e.currentTarget as HTMLSelectElement).value))}>
    {#each KEEP_CHOICES as c (c.bytes)}<option value={c.bytes}>{c.label}</option>{/each}
  </select></label> <span class="meta">{mb(keptBytes)} MB kept</span>{#if keptBytes > 0}{' '}<button class="clear" onclick={clearKept}>Clear</button>{/if}</p>
</section>

{#snippet logRow(group: Entry[], muted: boolean)}
  {@const first = group[0]}
  {@const p = rowParts(first)}
  <li class:muted>
    <span class="what">
      <span class="line">{#if p.bold}<strong>{p.label}</strong>{:else}<span class="label">{p.label}</span>{/if}{#if group.length > 1}{' · '}{group.length} logs{/if}
        {#if mixedEvents && placeOf(first) !== UNKNOWN.place}{' '}<span class="meta">{placeOf(first)}</span>{/if}</span>
      <span class="meta">{whenOf(group)}{#if p.extra}{' · '}{p.extra}{/if}{#if first.record.robot}{' · '}{first.record.robot.name}{/if}{#if first.attached.dslog.length + first.attached.dsevents.length}{' · '}with DS log{/if}</span>
      {#if group.some((e) => isLarge(sizeOf(e)))}<span class="meta large">Large: may not open on older phones.</span>{/if}
    </span>
    <span class="opens">
      {#each group as e (e.record.sha256)}
        <button class="open" disabled={!!opening} aria-label={`Open the ${rowParts(e).when} log, ${onThisPhone([e], kept).length ? 'on this phone' : `${mb(sizeOf(e))} MB`}`} onclick={() => open(e)}>{onThisPhone([e], kept).length ? 'Open · on this phone' : `Open · ${mb(sizeOf(e))} MB`}</button>
      {/each}
    </span>
  </li>
{/snippet}

{#if sheetOpen}
  <div class="scrim" role="presentation" onclick={closeSheet}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Filters" tabindex="-1" bind:this={sheetEl}>
    <div class="sheet-head"><strong>Filters</strong> <span class="meta">{shown.length} of {base.length} logs</span>
      {#if picks}<button class="clear" onclick={() => (selection = {})}>Clear</button>{/if}
      <button class="done" onclick={closeSheet}>Done</button></div>
    {#each sheet.multi as f (f)}
      <fieldset>
        <legend>{FACET_LABELS[f]}</legend>
        {#each counts[f] as [value, n] (value)}
          <label class="pick"><input type="checkbox" checked={selection[f]?.includes(value) ?? false} onchange={() => toggle(f, value)} />
            <span class="value">{value}</span><span class="n">{countLabel(selection, f, value, n)}</span></label>
        {/each}
      </fieldset>
    {/each}
    {#if sheet.single.length}<p class="meta only-one">Only one value: {sheet.single.map((x) => `${x.label} ${x.value}`).join(' · ')}</p>{/if}
  </div>
{/if}

<style>
  .phone-library { max-width: 46rem; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .problem { color: var(--error); }
  .explain { margin-top: 1.5rem; }
  .keep { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.25rem 0 0.75rem; }
  .bar { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0.5rem 0; }
  .here { display: flex; gap: 0.5rem; align-items: center; min-height: 44px; }
  .here input, .pick input { width: 1.25rem; height: 1.25rem; }
  .picks { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: center; margin: 0 0 0.5rem; }
  select { font: inherit; }
  h3 { font-size: 0.95rem; margin: 1.25rem 0 0.25rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
  li.fold { padding: 0; }
  .muted .label, .muted .what { color: var(--muted); }
  .what { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .opens { display: flex; flex-direction: column; gap: 0.35rem; }
  .sticky { position: sticky; top: 0; z-index: 1; }
  .sticky.error { background: var(--bg); padding: 0.25rem 0; border-bottom: 1px solid var(--border); }
  .sticky.error .problem { margin: 0; }
  .retry { min-height: 44px; min-width: 44px; }
  .sheet:focus { outline: none; }
  .only-one { margin: 0.75rem 0 0; }
  .large { color: var(--warning); }
  button { font: inherit; color: var(--fg); background: none; border: 1px solid var(--focus); border-radius: 6px; padding: 0.3rem 0.7rem; white-space: nowrap; cursor: pointer; }
  button:disabled { border-color: var(--border); color: var(--muted); }
  .filters, .done, .open { min-height: 44px; }
  .clear { min-height: 44px; min-width: 44px; border: none; text-decoration: underline; padding: 0 0.5rem; }
  .link { border: none; text-decoration: underline; padding: 0; }
  .foldline { width: 100%; min-height: 44px; text-align: left; white-space: normal; border: none; color: var(--muted); font-size: 0.9rem; padding: 0.3rem 0; }
  .caret { display: inline-block; width: 1rem; }
  .scrim { position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); z-index: 10; }
  .sheet { position: fixed; left: 0; right: 0; bottom: 0; max-height: 85vh; overflow-y: auto; z-index: 11; background: var(--bg); color: var(--fg); border-top: 1px solid var(--border); border-radius: 12px 12px 0 0; padding: 0 1rem 1.5rem; box-sizing: border-box; }
  .sheet-head { position: sticky; top: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; background: var(--bg); padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .done { margin-left: auto; }
  fieldset { border: none; padding: 0; margin: 0.75rem 0 0; min-width: 0; }
  legend { font-weight: 600; padding: 0; }
  .pick { display: flex; align-items: center; gap: 0.6rem; min-height: 44px; }
  .value { flex: 1; min-width: 0; }
  .n { color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
