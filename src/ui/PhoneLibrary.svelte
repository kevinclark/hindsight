<!-- The phone's Library: every robot log the team's laptops have shared to Drive, newest day first, filtered by event. Opening
     one downloads it (and its Driver Station logs) to this phone for Match review; nothing is kept once the app closes. -->
<script lang="ts">
  import type { BrowserHub, OpenedFile } from '../hub/browser-hub.ts'
  import type { Entry } from '../hub/catalog.ts'
  import type { LogRecord } from '../hub/types.ts'
  import { NO_EVENT, byDay, filterByEvent, isLarge, logLabel } from './phone-library.ts'

  /** `onOpening`: before a download starts, so the log held now can be let go first (one log in memory at a time). */
  let { hub, onOpening, onOpen }: { hub: BrowserHub; onOpening: () => void; onOpen: (files: OpenedFile[]) => void } = $props()

  const ALL = ''

  let entries = $state.raw<Entry[] | null>(null)
  let problem = $state<string | null>(null)
  let event = $state<string>(ALL)
  // Raw, and told apart by a number: a $state object would wrap `entry` in a proxy, so `opening.entry === entry` never
  // held, progress never showed, and the line never cleared (seen on the phone, 2026-11-09).
  let opening = $state.raw<{ id: number; entry: Entry; got: number; total: number; stop: AbortController } | null>(null)
  let opens = 0

  async function list() {
    problem = null
    try { entries = await hub.logs() } catch (e) { problem = `Could not list the team's logs (${e instanceof Error ? e.message : String(e)}).` }
  }
  void list()

  const events = $derived([...new Set((entries ?? []).map((e) => e.record.event).filter(Boolean))].sort())
  const days = $derived(byDay(filterByEvent(entries ?? [], event)))

  const mb = (n: number) => (n >= 10 * 2 ** 20 ? (n / 2 ** 20).toFixed(0) : (n / 2 ** 20).toFixed(1))
  const sizeOf = (e: Entry) => [e.record, ...e.attached.dslog, ...e.attached.dsevents].reduce((n, r) => n + r.size, 0)
  const time = (r: LogRecord) => (r.playedAt === null ? '' : new Date(r.playedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))

  /** Each step to the app's console (Xcode, `devicectl … launch --console`): a download that hangs shows where. */
  const say = (line: string) => console.log(`Hindsight Library: ${line}`)

  async function open(entry: Entry) {
    const stop = new AbortController()
    onOpening()
    const id = ++opens
    opening = { id, entry, got: 0, total: sizeOf(entry), stop }
    problem = null
    try {
      const files = await hub.openLog(entry, { signal: stop.signal, log: say, onProgress: (got, total) => { if (opening?.id === id) opening = { ...opening, got, total } } })
      say('downloaded; opening in Match review')
      onOpen(files)
    } catch (e) {
      say(`ended: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
      if (!stop.signal.aborted) problem = `Could not open ${entry.record.names[0]} (${e instanceof Error ? e.message : String(e)}).`
    } finally { if (opening?.id === id) opening = null }
  }
</script>

<section class="phone-library">
  <p class="meta">Every robot log your team's laptops have shared. Opening one downloads it to this phone (the size is on the button) and shows its full Match review; it isn't kept after the app closes.</p>
  {#if problem}<p class="problem" role="alert">{problem} <button class="link" onclick={list}>Try again</button></p>{/if}
  {#if opening}
    <div class="opening" role="status">
      <p>Downloading {opening.entry.record.names[0]}: {mb(opening.got)} of {mb(opening.total)} MB</p>
      <progress max={opening.total} value={opening.got}></progress>
      <button onclick={() => { say('Stop pressed'); opening?.stop.abort() }}>Stop</button>
    </div>
  {/if}
  {#if entries === null}
    {#if !problem}<p class="meta">Reading the team's list of logs…</p>{/if}
  {:else if entries.length === 0}
    <p class="meta">No laptop has shared logs to the team Drive yet: they go up when a laptop syncs.</p>
  {:else}
    <label class="filter">Event <select bind:value={event}>
      <option value={ALL}>All ({entries.length} logs)</option>
      {#each events as ev (ev)}<option value={ev}>{ev}</option>{/each}
      <option value={NO_EVENT}>No event</option>
    </select></label>
    {#each days as d (d.day)}
      <h3>{d.day}</h3>
      <ul>
        {#each d.logs as e (e.record.sha256)}
          {@const size = sizeOf(e)}
          <li>
            <span class="what"><strong>{logLabel(e.record)}</strong>{#if e.record.event}{' '}<span class="meta">{e.record.event}</span>{/if}
              <span class="meta">{time(e.record)}{#if e.record.robot}{' · '}{e.record.robot.name}{/if}{#if e.attached.dslog.length + e.attached.dsevents.length}{' · '}with DS log{/if}</span>
              {#if isLarge(size)}<span class="meta large">Large: may not open on older phones.</span>{/if}
            </span>
            <button disabled={!!opening} onclick={() => open(e)}>Open · {mb(size)} MB</button>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</section>

<style>
  .phone-library { max-width: 46rem; }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .problem { color: var(--error); }
  .filter { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 1rem; }
  select { font: inherit; }
  h3 { font-size: 0.95rem; margin: 1.25rem 0 0.25rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
  .what { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .large { color: var(--warning); }
  button { font: inherit; color: var(--fg); background: none; border: 1px solid var(--focus); border-radius: 6px; padding: 0.3rem 0.7rem; white-space: nowrap; cursor: pointer; }
  button:disabled { border-color: var(--border); color: var(--muted); }
  .link { border: none; text-decoration: underline; padding: 0; }
  .opening { position: sticky; top: 0; background: var(--bg); padding: 0.5rem 0; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; z-index: 1; }
  .opening p { margin: 0; flex-basis: 100%; }
  progress { flex: 1; }
</style>
