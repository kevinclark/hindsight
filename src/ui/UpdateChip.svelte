<!--
  The update label at the right of the tabs (desktop app only): says whether this copy is up to date, what it is doing about a
  newer release, and offers the one next step. The words come from src/hub/update-state.ts (contract: docs/contracts/update-state.md);
  the state comes from electron/updater.ts. A click opens a small popover (Escape or a click elsewhere closes it and returns focus
  to the label). It never opens by itself, never takes focus and never restarts the app unasked. After an update the popover
  also lists what's new since the version last seen on this computer (opening it marks that version seen).
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { hub } from '../hub/bridge.ts'
  import { CHECK_EVERY_MS, chip, clock, STALL_MS, type UpdateState } from '../hub/update-state.ts'
  import { builtChangelog, whatsNew } from '../now/changelog.ts'

  const KEY = 'hindsight.versionSeen'
  const MOST = 8
  const RELEASES = 'https://github.com/kevinclark/hindsight/releases'

  let { hasLogs }: { hasLogs: boolean } = $props()
  let st = $state<UpdateState | null>(null)
  let now = $state(Date.now())
  let open = $state(false)
  let lines = $state<string[]>([])
  let unseen = $state(false)
  let viewing = $state(false)
  /** The name of the job that a restart would stop, while the popover asks. */
  let busy = $state<string | null>(null)
  /** A Retry or Check now was asked and no answer has come yet (a retry from `failed` has no checking state of its own). */
  let asking = $state(false)
  /** When Restart now was pressed (the app should be gone within seconds; if it isn't, say so). */
  let restartAt = $state<number | null>(null)
  /** macOS is still unpacking the update: Restart was refused for now. */
  let preparing = $state(false)
  const RESTART_GRACE_MS = 20_000
  let root: HTMLDivElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()
  const id = $props.id()

  const remember = (v: string) => { try { localStorage.setItem(KEY, v) } catch { /* private window: asked again next time */ } }

  /** What's new is worked out once, when the running version is first known (as the old card on Now did). */
  let decided = false
  function learnVersion(version: string) {
    if (decided) return
    decided = true
    let seen: string | null = null
    try { seen = localStorage.getItem(KEY) } catch { /* private window */ }
    lines = whatsNew(builtChangelog(), version, seen, hasLogs)
    if (lines.length) unseen = true
    else remember(version)
  }
  const take = (s: UpdateState) => {
    // A new offer (or none) forgets an earlier Restart press and its answers.
    if (!st || st.kind !== s.kind || (st.kind === 'ready' && s.kind === 'ready' && st.next !== s.next)) { restartAt = null; preparing = false }
    st = s; asking = false; learnVersion(s.version)
  }

  onMount(() => {
    const api = hub()
    if (!api) return
    void api.updateState().then(take).catch(() => {})
    const off = api.onUpdateState(take)
    const tick = setInterval(() => { now = Date.now() }, 1000)
    const online = () => void api.updateCheck().catch(() => {})
    window.addEventListener('online', online)
    return () => { off(); clearInterval(tick); window.removeEventListener('online', online) }
  })

  const view = $derived(!st ? null : asking && (st.kind === 'failed' || st.kind === 'current') ? { ...chip(st, now, null), text: `${st.version} · checking…`, accent: false } : chip(st, now, unseen ? st.version : null))

  function show() {
    open = true
    busy = null
    if (st && unseen && !viewing) { remember(st.version); viewing = true }
  }
  function close(refocus: boolean) {
    open = false
    busy = null
    if (viewing) { unseen = false; viewing = false }
    if (refocus) button?.focus()
  }
  async function restart(force: boolean) {
    try {
      const r = await hub()!.updateRestart(force)
      busy = r.busy ?? null
      preparing = !!r.preparing
      if (r.started) restartAt = Date.now()
    } catch { busy = null }
  }
  const retry = () => { asking = true; void hub()?.updateCheck().then((started) => { if (!started) asking = false }).catch(() => { asking = false }) }
  const mb = (n: number) => (n / 1e6).toFixed(0)

  /** A download that has had no new bytes for STALL_MS. */
  const stalled = $derived(st?.kind === 'downloading' && now - st.lastDataAt >= STALL_MS)
</script>

<svelte:window
  onpointerdown={(e) => { if (open && root && !root.contains(e.target as Node)) close(false) }}
  onfocusin={(e) => { if (open && root && !root.contains(e.target as Node)) close(false) }}
  onkeydown={(e) => { if (open && e.key === 'Escape') { e.preventDefault(); close(true) } }} />

{#if view && st}
  <div class="chip-root screen-only" bind:this={root}>
    <button bind:this={button} type="button" class="chip" class:accent={view.accent} title={view.title} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? `${id}-pop` : undefined} data-update-chip={st.kind} onclick={() => (open ? close(false) : show())}>{view.text}</button>
    {#if open}
      <div class="pop" id="{id}-pop" role="dialog" aria-label="Updates" data-update-popover>
        {#if st.kind === 'ready'}
          {#if restartAt !== null && now - restartAt >= RESTART_GRACE_MS}
            <p>Hindsight didn't restart. Quit and reopen it to install {st.next}; the log says what happened.</p>
            <p class="row"><button type="button" onclick={() => void hub()?.showJobLog()}>Show log</button></p>
          {:else if restartAt !== null}
            <p>Restarting to install Hindsight {st.next}…</p>
          {:else if preparing}
            <p>macOS is still preparing Hindsight {st.next}. Try again in a few seconds.</p>
            <p class="row"><button type="button" class="primary" onclick={() => restart(false)}>Restart now</button></p>
          {:else if busy}
            <p>A {busy} is running. Restarting stops it.</p>
            <p class="row"><button type="button" class="primary" onclick={() => restart(true)}>Restart anyway</button><button type="button" onclick={() => close(true)}>Wait</button></p>
          {:else}
            <p><strong>Hindsight {st.next} is downloaded.</strong></p>
            <p class="row"><button type="button" class="primary" onclick={() => restart(false)}>Restart now</button></p>
            <p class="hint">Hindsight reopens by itself. Or keep working: it installs the next time you quit.</p>
            <p class="hint"><a href="{RELEASES}/tag/v{st.next}" target="_blank" rel="noreferrer">What's in {st.next}</a></p>
          {/if}
        {:else if st.kind === 'downloading'}
          <p>{#if stalled}Downloading Hindsight {st.next}: no data for {Math.round((now - st.lastDataAt) / 1000)} s.{:else}Downloading Hindsight {st.next}{#if st.total > 0}: {mb(st.transferred)} of {mb(st.total)} MB, {(st.bytesPerSecond / 1e6).toFixed(1)} MB/s{/if}.{/if}</p>
          <p class="hint">It installs when you quit, or you can restart once it's downloaded.</p>
        {:else if asking && (st.kind === 'failed' || st.kind === 'current')}
          <p>Checking for a newer Hindsight…</p>
        {:else if st.kind === 'failed'}
          <p>Couldn't check for or download an update since {clock(st.since)}: {st.reason}.</p>
          <p class="row"><button type="button" class="primary" onclick={retry}>Retry</button><button type="button" onclick={() => void hub()?.showJobLog()}>Show log</button></p>
        {:else if st.kind === 'manual'}
          <p>Hindsight {st.next} is out. This copy can't update itself: download the new version, open it, and drag Hindsight into Applications to replace this one.</p>
          <p class="row"><a class="link-button" href={st.url} target="_blank" rel="noreferrer">Download</a></p>
        {:else if st.kind === 'checking'}
          <p>Checking for a newer Hindsight…</p>
        {:else if st.kind === 'dev'}
          <p>A development build; it doesn't update itself.</p>
        {:else}
          {#if unseen}
            <p><strong>Updated to {st.version}. What's new:</strong></p>
            <ul>{#each lines.slice(0, MOST) as line (line)}<li>{line}</li>{/each}</ul>
            {#if lines.length > MOST}<p class="hint">and {lines.length - MOST} more: <a href={RELEASES} target="_blank" rel="noreferrer">all releases</a></p>{/if}
          {/if}
          <p>Hindsight {st.version}. Checked at {clock(st.checkedAt)}; checks every {CHECK_EVERY_MS / 3_600_000} hours.</p>
          <p class="row"><button type="button" onclick={retry}>Check now</button></p>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .chip-root { position: relative; margin-left: auto; min-width: 0; }
  .chip { max-width: 100%; min-height: 33px; padding: 0.3rem 0.6rem; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--muted); font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .chip:hover { border-color: var(--border); }
  .chip.accent { border: 1px solid var(--focus); color: var(--fg); }
  .chip:focus-visible, .pop button:focus-visible, .pop a:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .pop { position: absolute; z-index: 20; top: calc(100% + 2px); right: 0; width: 22rem; max-width: min(22rem, calc(100vw - 3rem)); padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); }
  .pop p { margin: 0 0 0.4rem; }
  .pop ul { margin: 0 0 0.4rem; padding-left: 1.2rem; }
  .hint { color: var(--muted); font-size: 0.85rem; }
  .row { display: flex; gap: 0.4rem; }
  .pop button, .link-button { min-height: 28px; padding: 0.2rem 0.7rem; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--muted); border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
  .pop button.primary { border-color: var(--focus); font-weight: 600; }
</style>
