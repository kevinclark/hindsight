<!--
  Library: every log the team has brought in, filtered by facet, opened in the Session view. Desktop app only (the page
  has no library when opened from disk).
  Design: the filter column is small multiples of one control (a checkbox list with a count), so facets are compared by
  eye and a pick shows what it would leave (Tufte, small multiples; NN/g, filters show result counts). The log list is
  a dense table grouped by day with the numbers right-aligned (Tufte, data-ink; NN/g, row actions only where used).
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { hub, LibraryFile, type DriveStatus, type LibrarySnapshot, type Progress, type SyncPlan } from '../hub/bridge.ts'
  import DriveFolderPicker from './DriveFolderPicker.svelte'
  import type { IngestPlan } from '../hub/ingest.ts'
  import type { FetchReport, SyncReport } from '../hub/sync.ts'
  import type { Entry } from '../hub/catalog.ts'
  import type { IngestReport } from '../hub/ingest.ts'
  import { FACETS, FACET_LABELS, facetCounts, facetValues, filterEntries, type FacetId, type Selection } from '../hub/facets.ts'
  import { baseName, dayText, withShaSuffix } from '../hub/layout.ts'
  import type { TagField, TagTarget } from '../hub/types.ts'

  let { onOpenSession }: { onOpenSession: (files: File[]) => void } = $props()
  const api = hub()

  let snapshot = $state.raw<LibrarySnapshot | null>(null)
  let selection = $state<Selection>({})
  let showStubs = $state(false)
  let progress = $state<Progress | null>(null)
  let report = $state.raw<IngestReport | null>(null)
  let problem = $state<string | null>(null)
  let expanded = $state<Record<string, boolean>>({})

  let drive = $state<DriveStatus | null>(null)
  let picking = $state<null | 'team' | 'ingest'>(null)
  let plan = $state<null | { kind: 'ingest'; folder: string; plan: IngestPlan } | { kind: 'sync'; plan: SyncPlan }>(null)
  let syncReport = $state.raw<SyncReport | null>(null)
  let fetchReport = $state.raw<FetchReport | null>(null)
  let clientId = $state('')
  let clientSecret = $state('')
  let robotAddress = $state((() => { try { return localStorage.getItem('hindsight.robotAddress') ?? '' } catch { return '' } })())
  const driveBusy = $derived(!!progress)

  async function refresh() {
    if (!api) return
    snapshot = await api.library()
    drive = await api.driveStatus()
  }
  /** Run something that can fail with words for the user; shows the progress bar while it works. */
  async function work<T>(label: string, body: () => Promise<T>): Promise<T | undefined> {
    if (!api || progress) return undefined
    problem = null
    progress = { job: label, done: 0, total: 0, current: '' }
    try { return await body() } catch (e) { problem = e instanceof Error ? e.message : String(e); return undefined } finally { progress = null; await refresh().catch(() => {}) }
  }
  const signIn = () => work('Signing in', () => api!.driveSignIn())
  const signOut = () => work('Signing out', () => api!.driveSignOut())
  const saveClient = () => work('Saving', () => api!.setGoogleClient(clientId, clientSecret))
  async function chooseTeam(idOrLink: string) { picking = null; await work('Checking the folder', () => api!.setTeamFolder(idOrLink)) }
  async function planIngest(idOrLink: string) {
    picking = null
    const p = await work('Looking at the folder', () => api!.driveIngestPlan(idOrLink))
    if (p) plan = { kind: 'ingest', folder: idOrLink, plan: p }
  }
  async function planSync() {
    const p = await work('Looking at the team folder', () => api!.syncPlan())
    if (p) plan = { kind: 'sync', plan: p }
  }
  async function confirm() {
    const p = plan
    plan = null
    if (!p) return
    if (p.kind === 'ingest') { const r = await work('Reading Drive folder', () => api!.addFromDrive(p.folder)); if (r) report = r }
    else { const r = await work('Syncing', () => api!.sync()); if (r) syncReport = r }
  }
  async function download() {
    const paths = filtered.filter((e) => !e.local && e.shared).map((e) => e.record.path)
    const r = await work('Downloading', () => api!.fetchLogs(paths))
    if (r) fetchReport = r
  }
  async function addRobot() {
    try { localStorage.setItem('hindsight.robotAddress', robotAddress) } catch { /* private window */ }
    const r = await work('Reading robot', () => api!.addFromRobot(robotAddress))
    if (!r) return
    if ('refused' in r) problem = r.refused
    else {
      report = r.report
      if (r.stillWriting.length) problem = `${r.stillWriting.length} file${r.stillWriting.length === 1 ? ' was' : 's were'} skipped as still being written (changed or modified in the last 30 s): ${r.stillWriting.slice(0, 3).join(', ')}${r.stillWriting.length > 3 ? '…' : ''}. Add logs from the robot again later.`
    }
  }
  let update = $state<{ version: string; url: string } | null>(null)

  onMount(() => {
    void refresh().catch((e) => { problem = String(e) })
    void api?.updateInfo().then((u) => { update = u })
    return api?.onProgress((p) => { if (progress) progress = p })
  })

  async function addFolder() {
    if (!api) return
    const r = await work('Reading folder', () => api.addFromFolder())
    if (r) report = r
  }

  async function tag(target: TagTarget, field: TagField, value: string) {
    if (!api) return
    try { await api.setTag(target, field, value); await refresh() } catch (e) { problem = String(e) }
  }

  const all = $derived(snapshot?.entries ?? [])
  const stubs = $derived(all.filter((e) => e.record.stub))
  const base = $derived(showStubs ? all : all.filter((e) => !e.record.stub))
  const filtered = $derived(filterEntries(base, selection))
  const counts = $derived(facetCounts(base, selection))
  const bytes = $derived(filtered.reduce((n, e) => n + e.record.size, 0))
  const local = $derived(filtered.filter((e) => e.local))
  /** Logs the team has that this computer lacks: what a download would fetch. */
  const remoteOnly = $derived(filtered.filter((e) => !e.local && e.shared))
  const attachments = $derived(filtered.reduce((n, e) => n + e.attached.dslog.length + e.attached.dsevents.length + e.attached.hoot.length, 0))

  const days = $derived.by(() => {
    const groups = new Map<string, Entry[]>()
    for (const e of filtered) {
      const day = e.record.playedAt === null ? 'No date' : dayText(e.record.playedAt)
      groups.set(day, [...(groups.get(day) ?? []), e])
    }
    return [...groups]
  })

  function toggle(f: FacetId, value: string) {
    const now = selection[f] ?? []
    selection = { ...selection, [f]: now.includes(value) ? now.filter((v) => v !== value) : [...now, value] }
  }
  const picked = $derived(FACETS.some((f) => selection[f]?.length))

  function openInSession() {
    if (!api) return
    // The Session view tells logs apart by name: two logs filed under the same name on different days get their sha-256 start added.
    const count = new Map<string, number>()
    for (const e of local) count.set(baseName(e.record.path), (count.get(baseName(e.record.path)) ?? 0) + 1)
    const nameOf = (e: Entry) => (count.get(baseName(e.record.path)) === 1 ? baseName(e.record.path) : withShaSuffix(baseName(e.record.path), e.record.sha256))
    const files = local.map((e) => new LibraryFile(nameOf(e), e.record.size, e.record.modifiedTime ?? e.record.recordedAt, e.record.path, api) as unknown as File)
    onOpenSession(files)
  }

  const size = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(n < 10 * 2 ** 20 ? 1 : 0)} MB`)
  const clock = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
  const matchText = (e: Entry) => {
    const r = e.record
    const type = ['', 'Practice', 'Qual', 'Elim'][r.matchType ?? 0]
    return type ? `${type}${r.matchNumber ? ` ${r.matchNumber}` : ''}` : ''
  }
  const dayTarget = (day: string): TagTarget => ({ day })
  const typed = (e: Event) => (e.currentTarget as HTMLInputElement).value
  /** The place typed for a day (from its first log: every log of the day shares it). */
  const dayPlace = (rows: Entry[]) => rows[0].tags.place ?? ''
</script>

{#if !api}
  <p class="meta">The library is part of the Hindsight desktop app. This page was opened from a file, so it has none.</p>
{:else}
<section class="bar">
  <button class="primary" onclick={addFolder} disabled={!!progress}>Add logs from a folder…</button>
  {#if drive?.signedIn}<button class="primary" onclick={() => (picking = 'ingest')} disabled={driveBusy}>Add logs from a Drive folder…</button>{/if}
  <span class="robot"><input bind:value={robotAddress} placeholder="robot address, 10.TE.AM.2" aria-label="Robot address" /><button class="primary" onclick={addRobot} disabled={driveBusy || !robotAddress.trim()}>Add logs from the robot</button></span>
  {#if progress}
    <span class="progress" role="status">
      {progress.job}{progress.total ? ` ${progress.done} of ${progress.total}` : '…'}{progress.current ? ` · ${progress.current}` : ''}
      <button class="link" onclick={() => api.cancel()}>Stop</button>
    </span>
  {/if}
  <span class="meta where">Library: <code>{snapshot?.libraryDir ?? '…'}</code></span>
</section>

{#if problem}<p class="problem" role="alert">{problem}</p>{/if}

<details class="team" open={drive !== null && !drive.teamFolder}>
  <summary>Team Drive: {#if !drive}…{:else if !drive.configured}not set up{:else if !drive.signedIn}not signed in{:else if !drive.teamFolder}signed in, no team folder yet{:else}<strong>{drive.teamFolder.name}</strong>{drive.lastSync ? ` · synced ${new Date(drive.lastSync).toLocaleString()}` : ' · not synced yet'}{/if}</summary>
  {#if drive && !drive.configured}
    <p class="meta">This build has no Google client. A team can make its own (a Desktop-app OAuth client in its Google Cloud project) and paste it here.</p>
    <p class="row"><input bind:value={clientId} placeholder="client id" aria-label="Google client id" /><input bind:value={clientSecret} placeholder="client secret" aria-label="Google client secret" /><button class="primary" onclick={saveClient} disabled={!clientId.trim()}>Save</button></p>
  {:else if drive && !drive.signedIn}
    <p class="meta">Signing in opens Google in your browser. Google shows a warning that Hindsight is an unverified app: choose <em>Advanced</em>, then <em>Go to Hindsight</em>.</p>
    <p><button class="primary" onclick={signIn} disabled={driveBusy}>Sign in with Google</button></p>
  {:else if drive}
    <p class="row">
      <button class="primary" onclick={() => (picking = 'team')} disabled={driveBusy}>{drive.teamFolder ? 'Change team folder…' : 'Choose the team folder…'}</button>
      {#if drive.teamFolder}<button class="primary" onclick={planSync} disabled={driveBusy}>Sync with the team…</button>{/if}
      <button class="link" onclick={signOut}>Sign out of Google</button>
    </p>
    {#if !drive.keepsSignIn}<p class="problem">{drive.keepWarning}</p>{/if}
  {/if}
  {#if picking && api}
    <DriveFolderPicker {api} label={picking === 'team' ? 'Use as team folder' : 'Read logs from'} onPick={(id) => (picking === 'team' ? chooseTeam(id) : planIngest(id))} onCancel={() => (picking = null)} />
  {/if}
  {#if plan}
    <p class="confirm" role="alert">
      {#if plan.kind === 'ingest'}
        {plan.plan.logs} log file{plan.plan.logs === 1 ? '' : 's'} there; {plan.plan.alreadyKnown} already in the library (not downloaded). <strong>Downloads {plan.plan.toRead} file{plan.plan.toRead === 1 ? '' : 's'}, {size(plan.plan.bytesToRead)}, in full, once.</strong> Nothing on Drive is changed; the copies go in this computer's library.
      {:else}
        <strong>Uploads {plan.plan.uploads} log{plan.plan.uploads === 1 ? '' : 's'}, {size(plan.plan.uploadBytes)}</strong> to the team folder (a log that came from Drive is copied inside Drive instead), brings in teammates' lists, and publishes this computer's. Nothing is deleted or overwritten.
      {/if}
      <button class="primary" onclick={confirm}>Go ahead</button> <button class="link" onclick={() => (plan = null)}>Cancel</button>
    </p>
  {/if}
</details>

{#if syncReport}
  <section class="report" aria-label="What was synced">
    <h2>Synced: {syncReport.uploaded.length} uploaded · {syncReport.alreadyThere} already there · {syncReport.failed.length} failed</h2>
    <p class="meta">{syncReport.manifests.length} teammate list{syncReport.manifests.length === 1 ? '' : 's'} brought in{syncReport.unrecorded.length ? ` · ${syncReport.unrecorded.length} file${syncReport.unrecorded.length === 1 ? '' : 's'} in the team folder that no list mentions` : ''}.</p>
    {#each syncReport.problems as p (p)}<p class="problem">{p}</p>{/each}
    {#if syncReport.failed.length}<details open><summary>Failed ({syncReport.failed.length})</summary><ul class="rows">{#each syncReport.failed as f (f.path)}<li><code>{f.path}</code> <span class="problem">{f.reason}</span></li>{/each}</ul></details>{/if}
    <button class="link" onclick={() => (syncReport = null)}>Dismiss</button>
  </section>
{/if}
{#if fetchReport}
  <section class="report" aria-label="What was downloaded">
    <h2>Downloaded {fetchReport.fetched.length} · failed {fetchReport.failed.length}</h2>
    {#each fetchReport.failed as f (f.path)}<p class="problem"><code>{f.path}</code> {f.reason}</p>{/each}
    <button class="link" onclick={() => (fetchReport = null)}>Dismiss</button>
  </section>
{/if}

{#if report}
  <section class="report" aria-label="What was added">
    <h2>Added {report.added.length} · already in the library {report.already.length} · couldn't read {report.unreadable.length}</h2>
    <p class="meta">
      {size(report.bytesAdded)} copied in {(report.durationMs / 1000).toFixed(1)} s. The originals were not moved, renamed or deleted.
      {#if report.ignored}{report.ignored} other file{report.ignored === 1 ? '' : 's'} ignored.{/if}
    </p>
    <ul class="flags">
      <li><strong>{report.added.filter((a) => a.undated).length}</strong> undated <span class="meta">(no robot clock, no date in the name: filed under <code>logs/undated</code>)</span></li>
      <li><strong>{report.added.filter((a) => a.stub).length}</strong> stubs <span class="meta">(under 1 MB, never enabled)</span></li>
    </ul>
    {#each [['Added', report.added], ['Already in the library', report.already], ["Couldn't read", report.unreadable]] as const as [title, rows] (title)}
      {#if rows.length}
        <details>
          <summary>{title} ({rows.length})</summary>
          <ul class="rows">
            {#each rows as row, i (i)}
              <li>
                <code>{row.name}</code>
                {#if 'reason' in row}<span class="problem">{row.reason}</span>
                {:else if 'names' in row}<span class="meta">is <code>{row.path}</code>{row.names.length > 1 ? `, also called ${row.names.filter((n) => n !== row.name).join(', ')}` : ''}</span>
                {:else}<span class="meta">→ <code>{row.path}</code> · {size(row.size)}{row.undated ? ' · undated' : ''}{row.stub ? ' · stub' : ''}</span>{/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {/each}
    <button class="link" onclick={() => (report = null)}>Dismiss</button>
  </section>
{/if}

<datalist id="places">{#each counts.place as [value] (value)}{#if !all.some((e) => e.record.onField && e.record.event === value)}<option {value}></option>{/if}{/each}</datalist>
<div class="layout">
  <aside aria-label="Filters">
    {#each FACETS as f (f)}
      <fieldset>
        <legend>{FACET_LABELS[f]}</legend>
        {#each counts[f] as [value, n] (value)}
          <label class:zero={n === 0}>
            <input type="checkbox" checked={selection[f]?.includes(value) ?? false} onchange={() => toggle(f, value)} />
            <span>{value}</span><span class="n">{n}</span>
          </label>
        {:else}<span class="meta">nothing yet</span>{/each}
      </fieldset>
    {/each}
    <label class="stubs"><input type="checkbox" bind:checked={showStubs} /> Show stubs ({stubs.length})</label>
    {#if picked}<button class="link" onclick={() => (selection = {})}>Clear filters</button>{/if}
  </aside>

  <section class="list">
    <div class="summary" role="status">
      <strong>{filtered.length}</strong> log{filtered.length === 1 ? '' : 's'} · {size(bytes)} · <strong>{local.length}</strong> on this computer{filtered.length - local.length ? ` (${filtered.length - local.length} not)` : ''}{attachments ? ` · ${attachments} DS or hoot files attached` : ''}
      {#if remoteOnly.length}<button class="primary" onclick={download} disabled={driveBusy}>Download {remoteOnly.length} ({size(remoteOnly.reduce((n, e) => n + e.record.size, 0))})</button>{/if}
      <button class="primary" onclick={openInSession} disabled={local.length === 0}>Open in Session view</button>
    </div>
    {#if all.length === 0}
      <p class="empty">No logs yet. Choose <em>Add logs from a folder…</em>: Hindsight copies what it finds into its library, files each log by what it says, and leaves your folder as it was.</p>
    {:else if filtered.length === 0}
      <p class="empty">No log matches these filters.</p>
    {/if}
    {#each days as [day, rows] (day)}
      <div class="day">
        <h3>{day}<span class="meta"> · {rows.length}</span></h3>
        {#if day !== 'No date'}
          <label class="tagfield">place <input list="places" value={dayPlace(rows)} placeholder="where (practice days)" onchange={(e) => tag(dayTarget(day), 'place', typed(e))} /></label>
          <label class="tagfield">driver <input value={rows[0].tags.driver ?? ''} placeholder="for the day" onchange={(e) => tag(dayTarget(day), 'driver', typed(e))} /></label>
        {/if}
      </div>
      <table>
        <tbody>
          {#each rows as e (e.record.sha256)}
            {@const v = facetValues(e)}
            <tr class:remote={!e.local}>
              <td class="time">{clock(e.record.playedAt)}</td>
              <td class="name"><code title={e.record.path}>{baseName(e.record.path)}</code></td>
              <td>{e.record.onField && e.record.event ? e.record.event : ''} {matchText(e)}</td>
              <td>{v.battery === 'No battery' ? '' : v.battery}</td>
              <td>{v.robot === 'Unknown robot' ? '' : v.robot}</td>
              <td><input class="driver" aria-label="Driver for this log" value={e.tags.driver ?? ''} placeholder="driver" onchange={(ev) => tag({ log: e.record.sha256 }, 'driver', typed(ev))} /></td>
              <td class="num">{size(e.record.size)}</td>
              <td class="flag" title={e.local ? 'On this computer' : 'Not on this computer'}>{e.local ? '' : '☁'}</td>
              <td><button class="link" aria-expanded={!!expanded[e.record.sha256]} onclick={() => (expanded[e.record.sha256] = !expanded[e.record.sha256])}>{expanded[e.record.sha256] ? 'less' : 'more'}</button></td>
            </tr>
            {#if expanded[e.record.sha256]}
              <tr class="more"><td></td><td colspan="8">
                <label class="tagfield">battery <input value={e.tags.battery ?? ''} placeholder={e.record.batteryId ?? 'not logged'} onchange={(ev) => tag({ log: e.record.sha256 }, 'battery', typed(ev))} /></label>
                <label class="tagfield">robot <input value={e.tags.robot ?? ''} placeholder={e.record.robot?.name ?? 'unknown'} onchange={(ev) => tag({ log: e.record.sha256 }, 'robot', typed(ev))} /></label>
                <p class="meta">
                  {#if e.names.length > 1}Also called {e.names.filter((n) => n !== baseName(e.record.path)).join(', ')}. {/if}
                  {#if e.attached.dslog.length}DS log: {e.attached.dslog.map((r) => r.names[0]).join(', ')}. {/if}
                  {#if e.attached.dsevents.length}DS events: {e.attached.dsevents.map((r) => r.names[0]).join(', ')}. {/if}
                  {#if e.attached.hoot.length}Hoot: {e.attached.hoot.map((r) => r.names[0]).join(', ')}. {/if}
                  Date from {e.record.dateSource}. <code>{e.record.sha256.slice(0, 12)}</code>
                </p>
              </td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {/each}
  </section>
</div>
{/if}

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; margin-bottom: 0.75rem; }
  .meta { color: var(--muted); font-size: 0.85rem; margin: 0; overflow-wrap: anywhere; }
  .where { margin-left: auto; }
  .robot { display: inline-flex; gap: 0.3rem; }
  .team { margin-bottom: 0.75rem; font-size: 0.9rem; }
  .team summary { cursor: pointer; min-height: 24px; }
  .row { display: flex; flex-wrap: wrap; gap: 0.4rem 0.6rem; align-items: center; }
  .confirm { border: 1px solid var(--warning); border-radius: 6px; padding: 0.4rem 0.75rem; max-width: 52rem; }
  button { font: inherit; color: var(--fg); }
  .primary { padding: 0.35rem 0.9rem; border: 1px solid var(--focus); border-radius: 6px; background: none; cursor: pointer; }
  .primary:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
  .link { border: none; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; min-height: 24px; padding: 0 0.3rem; }
  .problem { color: var(--error); margin: 0.25rem 0; }
  .report { border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 1rem; margin-bottom: 1rem; }
  .report h2 { font-size: 1rem; margin: 0.2rem 0; }
  .flags { display: flex; gap: 1.5rem; list-style: none; padding: 0; margin: 0.25rem 0; }
  .rows { margin: 0.25rem 0 0.5rem; padding-left: 1.2rem; max-height: 14rem; overflow: auto; font-size: 0.85rem; }
  .layout { display: grid; grid-template-columns: 14rem 1fr; gap: 1.5rem; align-items: start; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
  aside { font-size: 0.85rem; }
  fieldset { border: none; padding: 0; margin: 0 0 0.9rem; }
  legend { font-weight: 600; padding: 0; margin-bottom: 0.15rem; }
  aside label { display: flex; align-items: baseline; gap: 0.4rem; min-height: 22px; }
  aside label span:nth-of-type(1) { flex: 1; overflow-wrap: anywhere; }
  .n { color: var(--muted); font-variant-numeric: tabular-nums; }
  .zero { color: var(--muted); }
  .summary { position: sticky; top: 0; background: var(--bg); padding: 0.4rem 0; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; z-index: 2; }
  .summary .primary { margin-left: auto; }
  .empty { color: var(--muted); max-width: 60ch; }
  .day { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; margin-top: 1rem; }
  .day h3 { margin: 0; font-size: 0.95rem; }
  .tagfield { font-size: 0.8rem; color: var(--muted); display: inline-flex; align-items: baseline; gap: 0.3rem; margin-right: 0.75rem; }
  input:not([type='checkbox']) { font: inherit; font-size: 0.8rem; min-height: 24px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 0 0.3rem; max-width: 12rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  td { padding: 0.15rem 0.4rem; border-bottom: 1px solid var(--grid); vertical-align: baseline; }
  .time, .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .num { text-align: right; }
  .name { max-width: 20rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .driver { width: 7rem; }
  .remote { color: var(--muted); }
  .flag { width: 1.2rem; }
  .more td { border-bottom: 1px solid var(--border); }
</style>
