<!--
  Library: every log the team has brought in, filtered by facet, opened in the Session view. Desktop app only (the page
  has no library when opened from disk).
  Design: the filter column is small multiples of one control (a checkbox list with a count), so facets are compared by
  eye and a pick shows what it would leave, or "+N" for what it would add beside a pick in the same facet (Tufte, small multiples; NN/g, filters show result counts). The log list is
  a dense table grouped by day with the numbers right-aligned (Tufte, data-ink; NN/g, row actions only where used).
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { hub, type DriveStatus, type LibrarySnapshot, type Progress, type SyncPlan } from '../hub/bridge.ts'
  import DriveFolderPicker from './DriveFolderPicker.svelte'
  import type { IngestPlan } from '../hub/ingest.ts'
  import type { FetchReport, SyncReport } from '../hub/sync.ts'
  import type { Entry } from '../hub/catalog.ts'
  import type { IngestReport } from '../hub/ingest.ts'
  import { FACETS, FACET_LABELS, countLabel, facetCounts, facetValues, filterEntries, fmsPlace, robotIsGuess, robotLabels, type FacetId, type Places, type Selection } from '../hub/facets.ts'
  import { eventPlaces } from '../hub/event-places.ts'
  import { REFUSED_WORDS, identifyEvents } from '../tba/identify.ts'
  import { setAppHasKey, tbaGetter, tbaHasKey, tbaMissing } from './tba-setting.svelte.ts'
  import { baseName, dayText } from '../hub/layout.ts'
  import type { TagField, TagTarget } from '../hub/types.ts'
  import { ADD_LINK_REQUESTS, describeCodeLink } from '../hub/codelink.ts'
  import { setTeamNow } from './team-setting.svelte.ts'
  import type { CodePlan, LastJob, LinkReport } from '../hub/bridge.ts'
  import { asFile, codeSpec, sessionNames } from '../hub/session-files.ts'
  import { robotsToProfile, type RobotToProfile } from '../hub/drafts.ts'
  import { keptNow } from './kept-profiles.svelte.ts'
  import { USB_ADDRESS } from '../foresight/addresses.ts'

  // `onOpenSession`: the filtered logs, in the Session view. `onOpenMatch`: one log, in Match review. `onDraft`: one log in the
  // profile builder, with "Use GitHub" filled in (`owner/repo@ref`).
  // `onReview`: switch to Match review (the empty library and a failed pull offer it for one match's log).
  let { onOpenSession, onOpenMatch, onDraft, onReview }: { onOpenSession: (files: File[]) => void; onOpenMatch: (files: File[]) => void; onDraft: (files: File[], spec: string) => void; onReview?: () => void } = $props()
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
  /** Whether this page started the job whose bar is showing (else another start, or a page load mid-job, and the page polls). */
  let ownWork = $state(false)
  const foreign = $derived(!!progress && !ownWork)

  async function refresh() {
    if (!api) return
    snapshot = await api.library()
    drive = await api.driveStatus()
  }
  /** Run something that can fail with words for the user; shows the progress bar while it works. */
  async function work<T>(label: string, body: () => Promise<T>): Promise<T | undefined> {
    if (!api || progress) return undefined
    problem = null
    pullFailed = null // the last pull's failure is old news once anything else is tried
    progress = { job: label, done: 0, total: 0, current: '' }
    lastJob = null // a new job's own report replaces the old one
    ownWork = true
    try { return await body() } catch (e) { problem = e instanceof Error ? e.message : String(e); return undefined } finally { ownWork = false; progress = null; await refresh().catch(() => {}) }
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
    const paths = fetchable.map((r) => r.path)
    const r = await work('Downloading', () => api!.fetchLogs(paths))
    if (r) fetchReport = r
  }
  /** A pull that never reached the robot (not a refusal because it is enabled or on the field): the words a student needs, and the real text kept under them. */
  let pullFailed = $state<{ address: string; detail: string } | null>(null)
  const NOT_REACHED = /^(Could not check the robot|The robot did not say whether)/
  async function addRobot(address: string = robotAddress) {
    try { localStorage.setItem('hindsight.robotAddress', robotAddress) } catch { /* private window */ }
    pullFailed = null
    const r = await work('Reading robot', async () => {
      try { return await api!.addFromRobot(address) } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        if (/^That is not a robot address/.test(detail)) throw e
        pullFailed = { address, detail }
        return undefined
      }
    })
    if (!r) return
    if ('refused' in r) { if (NOT_REACHED.test(r.refused)) pullFailed = { address, detail: r.refused }; else problem = r.refused }
    else {
      report = r.report
      if (r.stillWriting.length) problem = `${r.stillWriting.length} file${r.stillWriting.length === 1 ? ' was' : 's were'} skipped as still being written (changed or modified in the last 30 s): ${r.stillWriting.slice(0, 3).join(', ')}${r.stillWriting.length > 3 ? '…' : ''}. Add logs from the robot again later.`
    }
  }
  /** The empty library's pull: the typed address, else the USB tether's (the same for every team). */
  const pullUsb = () => addRobot(robotAddress.trim() || USB_ADDRESS.value)
  let update = $state<{ version: string; url: string } | null>(null)

  onMount(() => {
    void refresh().catch((e) => { problem = String(e) })
    void api?.updateInfo().then((u) => { update = u })
    // A job already running (the page was reloaded, or something else started it) gets the same bar.
    void api?.codePlan().then((p) => { codePlan = p; codeText = p.sources.join(', ') }).catch(() => {})
    void api?.team().then((t) => { teamBox = t.team; savedTeam = t.team; setAppHasKey(!!t.tbaKey) }).catch(() => {})
    // How the job that finished last ended, for a page that reloaded and did not see it (kept for 30 minutes).
    void api?.lastJob().then((j) => { if (j && Date.now() - j.at < 30 * 60e3) lastJob = j }).catch(() => {})
    void api?.runningJob().then((p) => { if (p && !progress) progress = p }).catch(() => {})
    return api?.onProgress((p) => {
      if (p) progress = p
      else if (!ownWork && progress) { progress = null; void refresh().catch(() => {}) } // the job ended
    })
  })
  // Safety net for a bar this page did not start: ask the app every 2 s whether the job is still running.
  $effect(() => {
    if (!foreign || !api) return
    const timer = setInterval(() => {
      void api.runningJob().then((p) => { if (!p) { progress = null; void refresh().catch(() => {}) } else if (!ownWork) progress = p }).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  })
  let codePlan = $state<CodePlan | null>(null)
  let codeText = $state('')
  let teamBox = $state<number | null>(null) // a number input binds a number, or null when empty
  let savedTeam = $state<number | null>(null)
  let keyBox = $state('') // empty: leave the saved key as it is
  let lookupNote = $state('')
  let linkReport = $state.raw<LinkReport | null>(null)
  let lastJob = $state.raw<LastJob | null>(null)
  const linkLabel = $derived(!codePlan ? 'Link code' : codePlan.logs === 0
    ? `Link code (${codePlan.unstamped ? 'no logs to link; read logs again first?' : 'no logs to link'})`
    : `Link code (at least ${codePlan.requests} requests)`)
  /** Saves the number and the sources together; with sources set, the app then links every log it can (the same pass as Link code). */
  async function saveTeam() {
    const sources = codeText.split(/[\s,]+/).filter(Boolean)
    const saved = await work('Saving', () => api!.setTeam(teamBox ?? null, sources, keyBox.trim() || undefined))
    if (saved) {
      savedTeam = saved.team; teamBox = saved.team; codeText = saved.sources.join(', '); keyBox = ''
      setTeamNow(saved.team); setAppHasKey(!!saved.tbaKey)
      if (saved.linkNeeded) { const r = await work('Linking code', () => api!.linkCode()); if (r) linkReport = r }
    }
    codePlan = await api!.codePlan().catch(() => codePlan)
  }
  async function removeKey() {
    const saved = await work('Saving', () => api!.setTeam(savedTeam, codePlan?.sources ?? [], null))
    if (saved) setAppHasKey(!!saved.tbaKey)
  }
  async function linkCode() {
    const r = await work('Linking code', () => api!.linkCode())
    if (r) linkReport = r
    codePlan = await api!.codePlan().catch(() => codePlan)
  }
  /** A report's counts as words: each number, and the length of each list. */
  const reportText = (report: unknown) => (typeof report === 'object' && report !== null
    ? Object.entries(report).flatMap(([k, v]) => (typeof v === 'number' ? [`${k} ${v}`] : Array.isArray(v) ? [`${k} ${v.length}`] : [])).join(' · ')
    : '')
  async function readAgain() {
    const r = await work('Reading logs again', () => api!.redescribe())
    if (r) rereadReport = r
  }
  let rereadReport = $state.raw<import('../hub/redescribe.ts').RedescribeReport | null>(null)

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
  /** Robots only a Codebase text names and no profile kept in this browser covers: over every log, like the labels. */
  const toProfile = $derived(robotsToProfile(all, new Set(keptNow().flatMap((p) => (p.codebase ? [p.codebase] : [])))))
  /** Decided over every log, so a filter or the stubs switch never renames a robot. */
  const labels = $derived(robotLabels(all))
  /** Events The Blue Alliance names for on-field logs with no FMS event name (src/tba/identify.ts), by sha-256; empty with no key or team. */
  let places = $state.raw<Places>(new Map())
  $effect(() => {
    const get = tbaGetter(), team = savedTeam
    const logs = all.filter((e) => e.record.kind === 'wpilog' && !e.record.stub).map((e) => ({
      fileName: e.record.sha256, playedAt: e.record.playedAt, onField: e.record.onField, event: e.record.event,
      matchLabel: e.record.matchType === 2 && e.record.matchNumber ? `Qualification ${e.record.matchNumber}` : '',
    }))
    if (!get || team === null) { places = eventPlaces(all, new Map()); lookupNote = tbaMissing() ?? ''; return }
    let stale = false
    void identifyEvents(logs, team, get).then((r) => {
      if (stale) return
      places = eventPlaces(all, r.byFile)
      const unnamed = r.clusters.filter((c) => c.why === 'no event' || c.why === 'tie')
      const refused = r.clusters.some((c) => c.why === 'refused'), lost = r.clusters.filter((c) => c.why === 'unreachable').length
      const oldest = Math.min(Infinity, ...[...r.byFile.values()].map((v) => v.fromCache ? v.fetchedAt : Infinity))
      lookupNote = `${r.byFile.size} log${r.byFile.size === 1 ? '' : 's'} named from The Blue Alliance${refused ? `. ${REFUSED_WORDS}` : ''}${lost ? `. The Blue Alliance could not be reached for ${lost} group${lost === 1 ? '' : 's'} of logs and no saved copy covers them` : ''}${unnamed.length ? `; ${unnamed.length} group${unnamed.length === 1 ? '' : 's'} of logs with no event name matched no single event` : ''}${Number.isFinite(oldest) ? `; from a saved copy fetched ${new Date(oldest).toLocaleString()}` : ''}.`
    }).catch(() => { if (!stale) lookupNote = 'The Blue Alliance could not be asked.' })
    return () => { stale = true }
  })
  const filtered = $derived(filterEntries(base, selection, labels, places))
  const counts = $derived(facetCounts(base, selection, labels, places))
  const bytes = $derived(filtered.reduce((n, e) => n + e.record.size, 0))
  const local = $derived(filtered.filter((e) => e.local))
  /** Logs the team has that this computer lacks: what a download would fetch. */
  const fetchable = $derived(filtered.flatMap((e) => e.toFetch))
  const attachments = $derived(filtered.reduce((n, e) => n + e.attached.dslog.length + e.attached.dsevents.length + e.attached.hoot.length, 0))

  const days = $derived.by(() => {
    const groups = new Map<string, Entry[]>()
    for (const e of filtered) {
      const day = e.record.playedAt === null ? 'No date' : dayText(e.record.playedAt)
      groups.set(day, [...(groups.get(day) ?? []), e])
    }
    return [...groups]
  })

  /** Every log of each day, before the filters (but after the stub setting). */
  const wholeDays = $derived.by(() => {
    const groups = new Map<string, Entry[]>()
    for (const e of base) {
      const day = e.record.playedAt === null ? 'No date' : dayText(e.record.playedAt)
      groups.set(day, [...(groups.get(day) ?? []), e])
    }
    return groups
  })

  function toggle(f: FacetId, value: string) {
    const now = selection[f] ?? []
    selection = { ...selection, [f]: now.includes(value) ? now.filter((v) => v !== value) : [...now, value] }
  }
  const picked = $derived(FACETS.some((f) => selection[f]?.length))

  function openInSession() {
    if (!api) return
    onOpenSession(sessionNames(local).map((n) => asFile(n, api)))
  }
  function draft(r: RobotToProfile) {
    if (api && r.source.kind === 'draft') onDraft([asFile({ entry: r.source.entry, name: baseName(r.source.entry.record.path) }, api)], codeSpec({ code: r.source.code, build: r.source.entry.record.build }))
  }
  function openMatch(e: Entry) {
    if (api) onOpenMatch([asFile({ entry: e, name: baseName(e.record.path) }, api)])
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
  /**
   * What a day's header shows for place. All logs on the field with one resolved event name: that name, no input. Otherwise an
   * input, labelled for what a person types there: the practice place (no log on the field) or the event (some are, but the
   * FMS name is not known, or differs).
   */
  function dayHeader(rows: Entry[]): { fixed: string } | { label: string; placeholder: string } {
    // From every log of the day the stub setting shows, not only those the filters leave: a filter must not change what the day is.
    const field = rows.filter((e) => e.record.onField)
    if (field.length === 0) return { label: 'practice place', placeholder: 'where' }
    const names = new Set(rows.map((e) => { const p = fmsPlace(e.record); return p?.resolved ? p.name : places.get(e.record.sha256) ?? null }))
    if (rows.every((e) => e.record.onField || places.has(e.record.sha256)) && names.size === 1 && !names.has(null)) return { fixed: [...names][0]! }
    return { label: 'event', placeholder: 'name' }
  }
  /** The place typed for a day (from its first log: every log of the day shares it). */
  const dayPlace = (rows: Entry[]) => rows[0].tags.place ?? ''
</script>

{#if !api}
  <p class="meta">The library is part of the Hindsight desktop app. This page was opened from a file, so it has none.</p>
{:else}
<section class="bar">
  <button class="primary" onclick={addFolder} disabled={!!progress}>Add logs from a folder…</button>
  {#if drive?.signedIn}<button class="primary" onclick={() => (picking = 'ingest')} disabled={driveBusy}>Add logs from a Drive folder…</button>{/if}
  {#if all.length}<button class="primary" onclick={readAgain} disabled={driveBusy} title="Read every log on this computer again with this version of Hindsight and update what the list says about it (robot, event). Nothing in the logs changes.">Read logs again</button>{/if}
  <span class="robot"><input bind:value={robotAddress} placeholder="robot address, 10.TE.AM.2" aria-label="Robot address" /><button class="primary" onclick={() => addRobot()} disabled={driveBusy || !robotAddress.trim()}>Add logs from the robot</button></span>
  {#if progress}
    <span class="progress" role="status">
      {progress.job}{progress.total ? ` ${progress.done} of ${progress.total}` : '…'}{progress.current ? ` · ${progress.current}` : ''}
      <button class="link" onclick={() => api.cancel()}>Stop</button>
    </span>
  {/if}
  <span class="meta where">Library: <code>{snapshot?.libraryDir ?? '…'}</code></span>
</section>

{#if problem}<p class="problem" role="alert">{problem}</p>{/if}
{#if pullFailed}
  <section class="pullfail" role="alert" aria-label="Robot not found">
    <p class="lead">Robot not found. Is the USB cable in and the robot on?</p>
    <p class="row"><button class="primary strong" onclick={() => addRobot(pullFailed!.address)} disabled={driveBusy}>Try again</button> or <button class="secondary" onclick={addFolder} disabled={driveBusy}>Add a folder of logs</button>{#if onReview} or <button class="secondary" onclick={onReview}>Open one match's log</button>{/if}</p>
    <p class="meta">What came back from {pullFailed.address}: {pullFailed.detail}</p>
  </section>
{/if}

<details class="team" open={savedTeam === null && !codePlan?.sources.length}>
  <summary>Your team: {savedTeam === null ? 'no team number yet' : savedTeam}{codePlan?.sources.length ? ` · code from ${codePlan.sources.join(', ')}` : ' · no GitHub source yet'}</summary>
  <p class="meta">With your team number set, the robot lists show your team's robots. Logs that name only their code (no robot profile) can be linked to the public GitHub repo that holds it: give an organization or <code>owner/repo</code>, comma separated. Saving, and <em>Link code</em>, read each repo's <code>Robot.java</code> and ask GitHub about build commits; nothing is sent but repo and commit names.</p>
  <p class="row"><label>Team number <input type="number" min="1" max="99999" step="1" bind:value={teamBox} placeholder="e.g. 8033" aria-label="Team number" /></label>
    <label>GitHub organization or repos <input bind:value={codeText} placeholder="organization or owner/repo" aria-label="GitHub sources for code" /></label>
    <label>The Blue Alliance read key <input type="password" bind:value={keyBox} autocomplete="off" placeholder={tbaHasKey() ? 'saved: type to replace' : 'paste the key'} aria-label="The Blue Alliance read key" /></label>
    {#if tbaHasKey()}<button class="link" onclick={removeKey} disabled={driveBusy}>Remove key</button>{/if}
    <button class="primary" onclick={saveTeam} disabled={driveBusy}>Save</button>
    <button class="primary" onclick={linkCode} disabled={driveBusy || !codePlan?.sources.length || !codePlan.logs}>{linkLabel}</button></p>
  <p class="meta">The read key (from your account page on The Blue Alliance, Read API Keys) names events whose logs don't, and fetches your schedule. It stays on this computer, in this app's settings.{lookupNote ? ` ${lookupNote}` : ''}</p>
  {#if codePlan?.sources.length}<p class="meta">Logs whose code is in {codePlan.sources.length === 1 ? 'this repo' : 'these repos'} are linked when they are added (at most {ADD_LINK_REQUESTS} GitHub requests each time). Saving links the logs already here, which can take {codePlan.requests} or more requests.</p>{/if}
</details>

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

{#if lastJob}
  <section class="report" aria-label="How the last job ended">
    <h2>{lastJob.job} finished at {new Date(lastJob.at).toLocaleTimeString()}{lastJob.error ? '' : `: ${reportText(lastJob.report)}`}</h2>
    {#if lastJob.error}<p class="problem">{lastJob.error}</p>{/if}
    <button class="link" onclick={() => (lastJob = null)}>Dismiss</button>
  </section>
{/if}
{#if linkReport}
  <section class="report" aria-label="What was linked">
    <h2>Linked {linkReport.linked} log{linkReport.linked === 1 ? '' : 's'} to their code · {linkReport.unmatched} named by no listed repo · {linkReport.repos} repos read</h2>
    <p class="meta">{linkReport.requests.api} GitHub API request{linkReport.requests.api === 1 ? '' : 's'}, {linkReport.requests.raw} file reads.{linkReport.rateLimitedUntil ? ` GitHub's request limit was reached: stopped, and what was found is kept. Try again after ${new Date(linkReport.rateLimitedUntil).toLocaleTimeString()}.` : ''}</p>
    {#each linkReport.problems as p (p)}<p class="problem">{p}</p>{/each}
    <button class="link" onclick={() => (linkReport = null)}>Dismiss</button>
  </section>
{/if}
{#if rereadReport}
  <section class="report" aria-label="What was read again">
    <h2>Read again: {rereadReport.changed} updated · {rereadReport.unchanged} the same · {rereadReport.skipped} already read by this version · {rereadReport.missing} not on this computer · {rereadReport.failed.length} failed</h2>
    {#each rereadReport.failed as f (f.path)}<p class="problem"><code>{f.path}</code> {f.reason}</p>{/each}
    <button class="link" onclick={() => (rereadReport = null)}>Dismiss</button>
  </section>
{/if}
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
      {#if report.linked !== undefined}Linked {report.linked} new log{report.linked === 1 ? '' : 's'} to their code with {report.linkRequests} GitHub request{report.linkRequests === 1 ? '' : 's'}.{#if report.linkCapped} Stopped after {ADD_LINK_REQUESTS} GitHub requests; Link code finishes the rest.{/if}{#if report.linkRateLimitedUntil} GitHub's request limit was reached: stopped, and what was found is kept. Try again after {new Date(report.linkRateLimitedUntil).toLocaleTimeString()}.{/if}{/if}
      {#if report.linkProblem}<span class="problem">Linking code did not finish: {report.linkProblem}</span>{/if}
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

{#if toProfile.length}
  <section class="report" aria-label="Robots with no profile">
    <h2>Robots with no profile</h2>
    <p class="meta">The review reads a log's motors, currents and limits from its robot's profile. A draft from the robot's code at the commit a log ran marks where each value came from; nothing uses it until a student checks it and keeps it in the profile builder.</p>
    <ul class="rows plain">
      {#each toProfile as r (r.name)}
        {@const code = r.source.kind === 'no code' ? null : describeCodeLink({ code: r.source.code, build: r.source.kind === 'draft' ? r.source.entry.record.build : null })}
        <li data-robot={r.name}>
          <strong>{r.name}</strong> · {r.logs} log{r.logs === 1 ? '' : 's'} ·
          {#if code}code <a href={code.url} target="_blank" rel="noreferrer">{code.text}</a>{/if}
          {#if r.source.kind === 'draft'}
            <button class="primary" onclick={() => draft(r)} title="Opens {baseName(r.source.entry.record.path)}, this robot's newest log linked to its code on this computer, in the profile builder with the code it ran ready to read from GitHub ({codeSpec({ code: r.source.code, build: r.source.entry.record.build })}). A session's offer may pick another commit: the one most of that session's logs ran.">Draft a profile from its code</button>
          {:else if r.source.kind === 'not here'}<span class="meta">none of its logs linked to code is on this computer: download one to draft from</span>
          {:else}<span class="meta">no code linked: set your GitHub organization under Your team</span>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<datalist id="places">{#each counts.place as [value] (value)}{#if !all.some((e) => (fmsPlace(e.record)?.name ?? places.get(e.record.sha256)) === value)}<option {value}></option>{/if}{/each}</datalist>
<div class="layout" class:bare={all.length === 0}>
  {#if all.length}<aside aria-label="Filters">
    {#each FACETS as f (f)}
      <fieldset>
        <legend>{FACET_LABELS[f]}</legend>
        {#each counts[f] as [value, n] (value)}
          <label class:zero={n === 0}>
            <input type="checkbox" checked={selection[f]?.includes(value) ?? false} onchange={() => toggle(f, value)} />
            <span>{value}</span><span class="n">{countLabel(selection, f, value, n)}</span>
          </label>
        {:else}<span class="meta">nothing yet</span>{/each}
      </fieldset>
    {/each}
    <label class="stubs"><input type="checkbox" bind:checked={showStubs} /> Show stubs ({stubs.length})</label>
    {#if picked}<button class="link" onclick={() => (selection = {})}>Clear filters</button>{/if}
  </aside>{/if}

  <section class="list">
    {#if all.length}<div class="summary" role="status">
      <strong>{filtered.length}</strong> log{filtered.length === 1 ? '' : 's'} · {size(bytes)} · <strong>{local.length}</strong> on this computer{filtered.length - local.length ? ` (${filtered.length - local.length} not)` : ''}{attachments ? ` · ${attachments} DS or hoot files attached` : ''}
      {#if fetchable.length}<button class="primary" onclick={download} disabled={driveBusy}>Download {fetchable.length} file{fetchable.length === 1 ? '' : 's'} ({size(fetchable.reduce((n, r) => n + r.size, 0))})</button>{/if}
      <button class="primary" onclick={openInSession} disabled={local.length === 0}>Open in Session view</button>
    </div>{/if}
    {#if all.length === 0}
      <div class="first" data-empty-library>
        <p class="lead">Your team's robot logs live here.</p>
        <p>Hindsight reads each one and lists what went wrong. It copies what it finds into its library and leaves your folder as it was.</p>
        <p class="row"><button class="primary strong" onclick={addFolder} disabled={!!progress}>Add a folder of logs…</button> <button class="secondary" onclick={pullUsb} disabled={driveBusy}>Pull logs off the robot</button> <span class="meta">Plug in the USB cable first.</span></p>
        {#if onReview}<p class="meta">Have one match's log?{' '}<button class="link" onclick={onReview}>Open it in Match review</button></p>{/if}
      </div>
    {:else if filtered.length === 0}
      <p class="empty">No log matches these filters.</p>
    {/if}
    {#each days as [day, rows] (day)}
      <div class="day">
        <h3>{day}<span class="meta"> · {rows.length}</span></h3>
        {#if day !== 'No date'}
          {@const head = dayHeader(wholeDays.get(day) ?? rows)}
          {#if 'fixed' in head}
            <span class="tagfield fixed">{head.fixed}</span>
          {:else}
            <label class="tagfield">{head.label} <input list="places" value={dayPlace(rows)} placeholder={head.placeholder} onchange={(e) => tag(dayTarget(day), 'place', typed(e))} /></label>
          {/if}
          <label class="tagfield">driver <input value={rows[0].tags.driver ?? ''} placeholder="for the day" onchange={(e) => tag(dayTarget(day), 'driver', typed(e))} /></label>
        {/if}
      </div>
      <table>
        <tbody>
          {#each rows as e (e.record.sha256)}
            {@const v = facetValues(e, labels, places)}
            {@const code = describeCodeLink(e.record)}
            {@const profileMark = !e.tags.robot && robotIsGuess(e.record) ? (e.record.robot?.profileId === null ? 'code name' : 'guess') : null}
            <!-- One mark for both guesses (the profile by fit, the edition by roboRIO), so a row never reads "(guess)(guess)". -->
            {@const guessWhy = [
              profileMark === 'guess' ? 'The robot was picked by how well the log fits its profile' : '',
              labels.get(e.record.sha256)?.guess ? `No edition in this log; same roboRIO as the other ${v.robot.split(' · ').pop()} logs of this robot` : '',
            ].filter(Boolean).join('. ')}
            <tr class:remote={!e.local}>
              <td class="time">{clock(e.record.playedAt)}</td>
              <td class="name">{#if e.local}<button class="link open" title={`Open ${e.record.path} in Match review`} onclick={() => openMatch(e)}><code>{baseName(e.record.path)}</code></button>{:else}<code title={e.record.path}>{baseName(e.record.path)}</code>{/if}</td>
              <td>{fmsPlace(e.record)?.name ?? places.get(e.record.sha256) ?? ''} {matchText(e)}</td>
              <td>{v.battery === 'No battery' ? '' : v.battery}</td>
              <td>{v.robot === 'Unknown robot' ? '' : v.robot}{#if profileMark === 'code name'}{' '}<span class="meta">(code name)</span>{/if}{#if guessWhy}{' '}<span class="meta" title={guessWhy}>(guess)</span>{/if}{#if code}<span class="meta">{' · '}<a href={code.url} target="_blank" rel="noreferrer">{code.text}</a></span>{/if}</td>
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
                  {#if e.record.roboRio}roboRIO {e.record.roboRio}. {/if}
                  {#if e.record.edition}Edition {e.record.edition}. {/if}
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
  .primary.strong { font-weight: 600; }
  .secondary { padding: 0.35rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); cursor: pointer; }
  .secondary:disabled { color: var(--muted); cursor: default; }
  .pullfail { border: 1px solid var(--error); border-radius: 8px; padding: 0.5rem 1rem; margin: 0.5rem 0 1rem; max-width: 52rem; }
  .lead { font-size: 1.1rem; font-weight: 600; margin: 0.2rem 0; }
  .first { max-width: 60ch; padding: 0.5rem 0; }
  .first p { margin: 0.4rem 0; }
  .primary:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
  .link { border: none; background: none; color: var(--muted); text-decoration: underline; cursor: pointer; min-height: 24px; padding: 0 0.3rem; }
  .problem { color: var(--error); margin: 0.25rem 0; }
  .report { border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 1rem; margin-bottom: 1rem; }
  .report h2 { font-size: 1rem; margin: 0.2rem 0; }
  .flags { display: flex; gap: 1.5rem; list-style: none; padding: 0; margin: 0.25rem 0; }
  .rows { margin: 0.25rem 0 0.5rem; padding-left: 1.2rem; max-height: 14rem; overflow: auto; font-size: 0.85rem; }
  .rows.plain { list-style: none; padding-left: 0; max-height: none; }
  .plain li { min-height: 28px; }
  .layout { display: grid; grid-template-columns: 14rem 1fr; gap: 1.5rem; align-items: start; }
  .layout.bare { display: block; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
  aside { font-size: 0.85rem; }
  fieldset { border: none; padding: 0; margin: 0 0 0.9rem; }
  legend { font-weight: 600; padding: 0; margin-bottom: 0.15rem; }
  aside label { display: flex; align-items: baseline; gap: 0.4rem; min-height: 24px; }
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
  .open { padding: 0; color: var(--fg); text-decoration-color: var(--border); }
  .open:hover { text-decoration-color: currentColor; }
  .driver { width: 7rem; }
  .fixed { color: var(--fg); font-size: 0.85rem; }
  .remote { color: var(--muted); }
  .flag { width: 1.2rem; }
  .more td { border-bottom: 1px solid var(--border); }
</style>
