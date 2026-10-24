<!--
  Hindsight: drop a match's .wpilog (and its .dslog if you have it) and read the lint report.
  Everything runs in this page. Files never leave the computer.
-->
<script lang="ts">
  import { analyzeFilesWithCode, type Analysis, type InputFile } from './analyze.ts'
  import { isUncommitted } from './match/git-dirty.ts'
  import { buildFindingsJson, findingsFileName } from './report/findings-json.ts'
  import MatchTab from './ui/MatchTab.svelte'
  import Menu from './ui/Menu.svelte'
  import PowerTab from './ui/PowerTab.svelte'
  import LimitsTab from './ui/LimitsTab.svelte'
  import LoggingTab from './ui/LoggingTab.svelte'
  import Wizard from './ui/Wizard.svelte'
  import SessionView from './ui/SessionView.svelte'
  import { standingKeys, type Session } from './session/session.ts'
  import SnapshotView from './ui/SnapshotView.svelte'
  import ForesightView from './ui/ForesightView.svelte'
  import LibraryView from './ui/LibraryView.svelte'
  import { hub } from './hub/bridge.ts'
  import { loadTeam, teamNow } from './ui/team-setting.svelte.ts'
  import { robotChoices } from './ui/robot-list.ts'
  import RobotOptions from './ui/RobotOptions.svelte'
  import { codeSpec, libraryLinks, libraryLogs, type LibraryLink } from './hub/session-files.ts'
  import ReviewReport from './ui/ReviewReport.svelte'
  import { buildCard } from './report/card.ts'
  import { cardToPngDataUrl, saveForSlack } from './report/card-png.ts'
  import { playedAt, reviewCard, reviewModel } from './report/review-model.ts'
  import { downloadText } from './ui/download.ts'
  import { VERSION } from './version.ts'
  import { HISTORY_FILE_NAME, mergeHistory, parseHistory, serializeHistory, triage, type HistoryEvent, type IssueStatus, type PitCheckEvent } from './triage/history.ts'
  import { howSure, matchRef, realHere, trackRecord, withMarks, wrongHere, type Fire } from './triage/track-record.ts'
  import type { Finding } from './rules/types.ts'
  import { PROFILES, profileId } from './profiles/index.ts'
  import { namesRobot, robotName } from './profiles/choose.ts'
  import { chooseRobot, chosenRobot, HOW_WORDS } from './ui/robot-choice.ts'
  import ProfileBuilder from './ui/ProfileBuilder.svelte'
  import { profilesNow } from './ui/kept-profiles.svelte.ts'
  import CodeFolderControl from './ui/CodeFolderControl.svelte'
  import { codeFolder } from './ui/code-folder.svelte.ts'

  // Every file dropped so far, so a .dslog dropped after its .wpilog still finds its match. "Clear" empties it.
  let inputs: InputFile[] = []
  let analyses = $state<Analysis[]>([])
  let problems = $state<string[]>([])
  let selected = $state(0)
  let tab = $state<'match' | 'power' | 'limits' | 'logging'>('match')
  // Review match logs, a whole session of them, the limits wizard, or a robot snapshot (device settings and faults).
  let mode = $state<'review' | 'session' | 'wizard' | 'snapshot' | 'profile' | 'foresight' | 'library'>(hub() ? 'library' : 'review')
  // Robot profiles kept in this browser (built in the Robot profile mode), offered beside the built-in ones.
  const stored = $derived(profilesNow())

  // From the Session view: open one match's log (every piece, if the robot program restarted during it) in Match review.
  async function openFromSession(files: File[]) {
    mode = 'review'
    tab = 'match'
    await load(files)
  }
  // The Library is part of the desktop app (src/hub/): the page opened from disk has no library, so no tab for it.
  const MODES = [
    ...(hub() ? [{ id: 'library', label: 'Library' } as const] : []),
    { id: 'review', label: 'Match review' }, { id: 'session', label: 'Session' }, { id: 'wizard', label: 'Limits wizard' },
    { id: 'snapshot', label: 'Robot snapshot' }, { id: 'profile', label: 'Robot profile' }, { id: 'foresight', label: 'Foresight' },
  ] as const
  if (hub()) document.getElementById('app')?.classList.add('wide')
  // The desktop app asks GitHub once on start whether a newer release is out.
  let update = $state<{ version: string; url: string } | null>(null)
  void hub()?.updateInfo().then((u) => { update = u })
  void loadTeam()
  let sessionView = $state<{ addFiles(files: File[]): Promise<void> }>()
  // Session summaries restored without their file read the library's copy (desktop app only).
  const findInLibrary = hub() ? (names: string[]) => libraryLogs(hub()!, names) : undefined
  const linksInLibrary = hub() ? (names: string[]) => libraryLinks(hub()!, names) : undefined
  let profileBuilder = $state<{ start(files: File[], spec: string): Promise<void> }>()
  // From a session's "Draft a profile from it": the library's copy of that log, in the profile builder, with the linked code to read.
  async function draftFromCode(link: LibraryLink) {
    await startDraft(await libraryLogs(hub()!, [link.name]), codeSpec(link))
  }
  // From the Library's "Robots with no profile", or a session's offer: the log in the profile builder, its code to read.
  async function startDraft(files: File[], spec: string) {
    mode = 'profile'
    await profileBuilder?.start(files, spec)
  }
  // From the Library: the filtered logs, in the Session view.
  async function openInSession(files: File[]) {
    mode = 'session'
    await sessionView?.addFiles(files)
  }
  // With a log loaded the dashed drop row is gone (dropping anywhere still works): Choose logs… stays beside the File menu.
  function chosen(e: Event) { const input = e.currentTarget as HTMLInputElement; load(input.files ?? []); input.value = '' }
  let busy = $state(false)
  let dragging = $state(false)
  let lastLoad = $state<{ files: number; readMs: number; analyzeMs: number; heapMB: number | null } | null>(null)

  const current = $derived(analyses[selected] as Analysis | undefined)

  // The sessions the Session view holds, and the issues that fired in every match of the current match's session
  // (Match review folds them; no loaded session holding this match means nothing folds). A match joined from several
  // logs is listed under its first log's name, with every piece in `pieces` (summary.ts joinPieces).
  let sessions = $state.raw<Session[]>([])
  const standing = $derived.by(() => {
    if (!current) return new Set<string>()
    const name = current.match.fileName
    const own = sessions.find((s) => s.matches.some((m) => m.fileName === name || m.pieces?.includes(name)))
    return own ? standingKeys(own) : new Set<string>()
  })

  // Known issues: kept in this browser between visits, and saved to / loaded from hindsight-history.jsonl.
  const STORE = 'hindsight.history'
  let history = $state<HistoryEvent[]>(readStoredHistory())
  let unsaved = $state(false)
  const marks = $derived(triage(history))
  const issues = $derived(marks.issues)

  // The current match as the team's marks show it: reds that a wrong mark on another match of this event demotes are
  // amber, and this match's own wrong marks. The other tabs read the log as it is.
  const refOf = (a: Analysis) => matchRef(a.match, playedAt(a))
  const here = $derived(current ? refOf(current) : null)
  const marked = (a: Analysis) => withMarks(a, refOf(a), marks)
  const shownCurrent = $derived(current ? marked(current) : undefined)
  const wrongNow = $derived(here ? wrongHere(here, marks) : new Map())
  const realNow = $derived(here ? realHere(here, marks) : new Map())
  // Every warning or error in the open logs (Match review and Session), for each check's track record.
  const fires = $derived.by(() => {
    const out: Fire[] = []
    for (const a of analyses) {
      const { id, played } = refOf(a)
      for (const f of a.report.findings) if (f.severity !== 'info') out.push({ key: f.key, match: id, played })
    }
    for (const s of sessions) for (const m of s.matches) {
      const { id, played } = matchRef(m, m.playedAt)
      for (const r of Object.values(m.rules)) for (const f of r.findings) if (f.severity !== 'info') out.push({ key: f.key, match: id, played })
    }
    return out
  })
  const anyMarks = $derived(history.some((e) => e.type === 'issue'))
  // Each check's How sure line, worked out once per check while the marks and open logs stay the same.
  const sure = $derived.by(() => {
    // Read here, not only inside the returned function, so the cache is rebuilt whenever they change.
    const [t, events, open, any] = [marks, history, fires, anyMarks]
    const lines = new Map<string, string | null>()
    return (rule: string) => {
      if (!lines.has(rule)) lines.set(rule, howSure(trackRecord(rule, t, events, open), any))
      return lines.get(rule)!
    }
  })

  function readStoredHistory(): HistoryEvent[] {
    try { return parseHistory(localStorage.getItem(STORE) ?? '').events } catch { return [] }
  }
  function keep(events: HistoryEvent[], changed: boolean) {
    history = events
    if (changed) unsaved = true
    try { localStorage.setItem(STORE, serializeHistory(events)) } catch { /* private window: the file is the only copy */ }
  }
  function mark(finding: Finding, status: IssueStatus, note: string) {
    const at = here ? { match: here.id, ...(here.event ? { event: here.event } : {}), ...(here.played !== null ? { played: new Date(here.played).toISOString() } : {}) } : {}
    keep([...history, { type: 'issue', key: finding.key, status, note, when: new Date().toISOString(), ...at }], true)
  }
  function saveHistory() {
    downloadText(HISTORY_FILE_NAME, serializeHistory(history), 'application/x-ndjson')
    unsaved = false
  }

  async function load(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    busy = true
    const pass = ++passes
    await new Promise((r) => setTimeout(r, 30)) // let "Reading…" paint
    try {
      const started = performance.now()
      const added: InputFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
      // The same file dropped twice replaces the first copy.
      const sameFile = (a: InputFile, b: InputFile) => a.name === b.name && a.bytes.length === b.bytes.length
      inputs = [...inputs.filter((old) => !added.some((n) => sameFile(old, n))), ...added]
      const read = performance.now()
      const result = await analyzeFilesWithCode(inputs, codeFolder.current, chosenRobot, [...PROFILES, ...stored])
      if (result.history.length) keep(mergeHistory(history, result.history), false)
      if (pass !== passes) return // a later pass (another code folder, another robot) has the newer answer
      const done = performance.now()
      analyses = result.analyses
      problems = result.problems
      const newest = result.analyses.findIndex((a) => added.some((f) => f.name === a.match.fileName))
      selected = Math.max(0, newest)
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      lastLoad = { files: files.length, readMs: read - started, analyzeMs: done - read, heapMB: mem ? mem.usedJSHeapSize / 2 ** 20 : null }
    } catch (error) {
      problems = [String(error)]
    } finally {
      if (pass === passes) busy = false
    }
  }

  // The student picked another robot for this log: run it again with that profile.
  function setRobot(id: string) {
    if (!current) return
    chooseRobot([current.match.fileName], id === 'auto' ? null : id)
    reanalyze()
  }

  // Read the loaded logs again, keeping the same match selected (another robot picked, another code folder chosen).
  async function reanalyze() {
    const file = current?.match.fileName
    const pass = ++passes
    busy = true
    try {
      const result = await analyzeFilesWithCode(inputs, codeFolder.current, chosenRobot, [...PROFILES, ...stored])
      if (pass !== passes) return
      analyses = result.analyses
      selected = Math.max(0, analyses.findIndex((a) => a.match.fileName === file))
    } catch (error) {
      problems = [String(error)]
    } finally {
      if (pass === passes) busy = false
    }
  }
  // Each analysis pass is numbered; only the newest one's result is shown.
  let passes = 0
  // A code folder chosen (or forgotten) after logs were loaded: the limit findings may change.
  let seenFolder = codeFolder.version
  $effect(() => {
    if (codeFolder.version === seenFolder) return
    seenFolder = codeFolder.version
    if (inputs.length) reanalyze()
  })

  function clearAll() {
    inputs = []
    analyses = []
    problems = []
    lastLoad = null
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    // In the wizard, logs go to a step's own "Check it" box, not to Match review.
    if (mode !== 'review') return
    if (e.dataTransfer?.files) load(e.dataTransfer.files)
  }

  function downloadForClaude() {
    if (!current || !shownCurrent) return
    const json = JSON.stringify(buildFindingsJson(shownCurrent.match, shownCurrent.report, issues, wrongNow, realNow), null, 1)
    downloadText(findingsFileName(current.match), json)
  }

  // "Save for Slack": the browser's print dialog (Save as PDF; the title names the file), then the phone card as a PNG.
  const reviewCardOf = (a: Analysis) => buildCard(reviewCard(reviewModel(marked(a), issues, standing, wrongHere(refOf(a), marks))))
  let saveProblem = $state<string | null>(null)
  async function saveForSlackReview() {
    saveProblem = null
    if (!current) return
    const base = current.match.fileName.replace(/\.wpilog$/i, '')
    try { saveProblem = await saveForSlack(`${base}.report`, `${base}.card.png`, reviewCardOf(current)) } catch (error) { saveProblem = `Save for Slack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Print shows the report instead of the app, in Match review (with a log loaded), Foresight and Session (with a
  // session selected: SessionView hides its own screen content and prints SessionReport); other views print as they are.
  let sessionShown = $state(false)
  const reportable = $derived((mode === 'review' && !!current) || mode === 'foresight' || (mode === 'session' && sessionShown))

  // For automated checks (e.g. a test page that already has File objects): window.hindsight.load(files)
  ;(window as unknown as { hindsight: object }).hindsight = {
    load,
    version: VERSION,
    // For scripts/report.ts: the same builders the buttons use, for the log in view.
    findingsJson: () => (shownCurrent ? JSON.stringify(buildFindingsJson(shownCurrent.match, shownCurrent.report, issues, wrongNow, realNow), null, 1) : null),
    findingsFile: () => (current ? findingsFileName(current.match) : null),
    reviewCard: () => (current ? reviewCardOf(current) : null),
    reviewCardPng: async () => (current ? await cardToPngDataUrl(reviewCardOf(current)) : null),
    foresightCardPng: async () => { const c = (window as unknown as { hindsight: { foresightCard?: () => Parameters<typeof cardToPngDataUrl>[0] } }).hindsight.foresightCard?.(); return c ? await cardToPngDataUrl(c) : null },
    get timings() {
      return { lastLoad, matches: analyses.map((a) => ({ file: a.match.fileName, ...a.timing, findings: a.report.findings.length })) }
    },
  }

  const fmtDuration = (a: Analysis) => (a.match.matchStart !== null && a.match.matchEnd !== null ? `${(a.match.matchEnd - a.match.matchStart).toFixed(0)} s match` : 'never enabled')
</script>

<svelte:window ondragover={(e) => { e.preventDefault(); dragging = mode === 'review' }} ondragleave={(e) => { if (e.relatedTarget === null) dragging = false }} ondrop={onDrop} />

<div class="top" class:compact={mode === 'review' && !!current}>
<header class:screen-only={reportable}>
  <h1>Hindsight</h1>
  {#if !(mode === 'review' && current)}<p class="tag">Lints FRC robot match logs. Runs in this page; your files never leave this computer.</p>{/if}
</header>

{#if update}<p class="update screen-only">Hindsight {update.version} is out: <a href={update.url} target="_blank" rel="noreferrer">download</a></p>{/if}
<nav class="modes" class:screen-only={reportable} aria-label="Mode">
  {#each MODES as m (m.id)}<button class:active={mode === m.id} onclick={() => (mode = m.id)}>{m.label}</button>{/each}
</nav>
</div>

<!-- All the views stay mounted and only the active one shows, so switching never loses a loaded session,
     the matches in review, the wizard's progress, or a snapshot. -->
<div hidden={mode !== 'wizard'} class:screen-only={reportable}><Wizard matches={analyses} /></div>
<div hidden={mode !== 'snapshot'} class:screen-only={reportable}><SnapshotView /></div>
<div hidden={mode !== 'profile'} class:screen-only={reportable}><ProfileBuilder bind:this={profileBuilder} /></div>
<div hidden={mode !== 'foresight'}>
  <ForesightView {history} onPitCheck={(e: PitCheckEvent) => keep([...history, e], true)} />
  {#if unsaved}<p class="history screen-only">Changes were added to the team's history in this browser · <button class="link" onclick={saveHistory}>Save {HISTORY_FILE_NAME}</button></p>{/if}
</div>
{#if hub()}<div hidden={mode !== 'library'}><LibraryView onOpenSession={openInSession} onOpenMatch={openFromSession} onDraft={startDraft} /></div>{/if}
<div hidden={mode !== 'session'}><SessionView bind:this={sessionView} {marks} onOpen={openFromSession} findLogs={findInLibrary} linksFor={linksInLibrary} onDraft={draftFromCode} bind:hasSession={sessionShown} bind:sessionsOut={sessions} /></div>
<div hidden={mode !== 'review'} class:screen-only={reportable}>
{#if !current || dragging}
<section class="drop" class:compact={!!current} class:dragging aria-busy={busy}>
  <label class="button">
    <input type="file" multiple accept=".wpilog,.dslog,.dsevents,.jsonl" onchange={chosen} />
    Choose logs…
  </label>
  {#if current}
    <span>or drop files (<code>.wpilog</code>, <code>.dslog</code>, <code>.dsevents</code>, history)</span>
  {:else}
    <span>or drop a match's <code>.wpilog</code> (and its <code>.dslog</code> and <code>.dsevents</code>, and the team's <code>{HISTORY_FILE_NAME}</code>) anywhere on the page.</span>
  {/if}
  <CodeFolderControl suggest={current?.match.profile?.code} />
  {#if busy}<span class="busy">Reading…</span>{/if}
  {#if analyses.length}<button class="link" onclick={clearAll}>Clear all</button>{/if}
</section>
{/if}

{#each problems as p (p)}<p class="problem" role="alert">{p}</p>{/each}

{#if history.length}
  <p class="history">
    Known issues: {issues.size} tracked{#if marks.wrong.size}{' · '}{marks.wrong.size} marked not a real problem{/if}{#if marks.real.size}{' · '}{marks.real.size} marked a real problem{/if}{#if unsaved}{' · '}<strong>changes not saved to a file yet</strong>{/if}
    <button class="link" onclick={saveHistory}>Save {HISTORY_FILE_NAME}</button>
  </p>
{/if}

{#if analyses.length > 1}
  <nav class="matches" aria-label="Loaded matches">
    {#each analyses as a, i (i)}
      {@const errors = marked(a).report.findings.filter((f) => f.severity === 'error').length}
      <button class:active={i === selected} onclick={() => (selected = i)}>
        <span>{a.match.matchLabel || a.match.fileName}</span>
        <small>{errors} error{errors === 1 ? '' : 's'}</small>
      </button>
    {/each}
  </nav>
{/if}

{#if current}
  <section class="match-head">
    <h2>{current.match.event ? `${current.match.event} ` : ''}{current.match.matchLabel || 'Match'}</h2>
    <span class="actions">
      {#if busy}<span class="busy">Reading…</span>{/if}
      <label class="button choose">
        <input type="file" multiple accept=".wpilog,.dslog,.dsevents,.jsonl" onchange={chosen} />
        Choose logs…
      </label>
      <Menu label="File" align="right" items={[
        { id: 'claude', label: 'Download for Claude', hint: 'findings.json: findings, evidence and short data windows', onselect: downloadForClaude },
        { id: 'slack', label: 'Save for Slack', hint: 'print dialog (choose Save as PDF) and a phone-sized card (PNG)', onselect: saveForSlackReview },
        { id: 'clear', label: 'Clear all', hint: 'forget the loaded logs', onselect: clearAll },
      ]} />
    </span>
    <div class="rest">
      <p class="meta">
        <code>{current.match.fileName}</code>{#each current.match.ds as d (d.fileName)}{' + '}<code>{d.fileName}</code>{/each} ·
        {fmtDuration(current)} · code <code>{current.match.build.sha.slice(0, 7) || '?'}</code> on {current.match.build.branch || '?'}
        {#if isUncommitted(current.match.build.dirty)}<strong class="dirty">(uncommitted changes)</strong>{/if}
      </p>
      <details class="more">
        <summary>Robot: <strong>{robotName(current.match.profile.name, current.match.profileChoice)}</strong></summary>
        <p class="meta">
          {#if !namesRobot(current.match.profileChoice)}No profile is for this robot ·{:else}Code as of {current.match.profile.code.branch} <code>{current.match.profile.code.sha}</code>
          ({HOW_WORDS[current.match.profileChoice.how]}) ·{/if}
          <label>use <select onchange={(e) => setRobot((e.currentTarget as HTMLSelectElement).value)}>
            <option value="auto" selected={current.match.profileChoice.how !== 'chosen by you'}>automatic</option>
            <RobotOptions groups={robotChoices(PROFILES, stored, teamNow(), namesRobot(current.match.profileChoice) ? [profileId(current.match.profile)] : [])} selectedId={current.match.profileChoice.how === 'chosen by you' ? profileId(current.match.profile) : null} />
          </select></label>
        </p>
      </details>
      {#if current.match.profileChoice.note}<p class="meta dirty">{current.match.profileChoice.note}</p>{/if}
    </div>
    {#if saveProblem}<p class="problem" role="alert">{saveProblem}</p>{/if}
  </section>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === 'match'} class:active={tab === 'match'} onclick={() => (tab = 'match')}>Match</button>
    <button role="tab" aria-selected={tab === 'power'} class:active={tab === 'power'} onclick={() => (tab = 'power')}>Power</button>
    <button role="tab" aria-selected={tab === 'limits'} class:active={tab === 'limits'} onclick={() => (tab = 'limits')}>Limits</button>
    <button role="tab" aria-selected={tab === 'logging'} class:active={tab === 'logging'} onclick={() => (tab = 'logging')}>Logging</button>
  </div>

  <main>
    {#if tab === 'match'}<MatchTab analysis={shownCurrent ?? current} {issues} wrong={wrongNow} real={realNow} {sure} {standing} onMark={mark} />{:else if tab === 'power'}<PowerTab analysis={current} />{:else if tab === 'limits'}<LimitsTab analysis={current} />{:else}<LoggingTab analysis={current} />{/if}
  </main>

  <footer>
    Hindsight {VERSION} · read {current.match.log.entries.size} signals, {current.match.log.recordCount.toLocaleString()} records ·
    index {current.timing.parseMs.toFixed(0)} ms, rules {current.timing.rulesMs.toFixed(0)} ms
    {#if lastLoad} · {lastLoad.files} file{lastLoad.files === 1 ? '' : 's'}: read {lastLoad.readMs.toFixed(0)} ms, analyse {lastLoad.analyzeMs.toFixed(0)} ms{#if lastLoad.heapMB !== null}, JS heap {lastLoad.heapMB.toFixed(0)} MB{/if}{/if}
    {#each current.match.log.warnings as w (w)}<br />Note: {w}{/each}
  </footer>
{:else if !busy}
  <section class="empty">
    <h2>How to use it</h2>
    <ol>
      <li>Get the match's log off the robot with AdvantageScope ("Download Logs"). For Phoenix <code>.hoot</code> files, export them as <code>.wpilog</code> in AdvantageScope first.</li>
      <li>Drop the <code>.wpilog</code> here. Add the Driver Station's <code>.dslog</code> and <code>.dsevents</code> for the same match if you have them (on the DS laptop in <code>C:\Users\Public\Documents\FRC\Log Files</code>).</li>
      <li>Read the <strong>Match</strong> tab worst first: red cost or nearly cost a match, amber is a margin eroding, grey is context.</li>
      <li>Open the <strong>Power</strong> tab for brownouts and battery health.</li>
    </ol>
    <p class="meta">Matches opened here aren't kept when the page reloads (the Session view keeps each log's summary, not the log): drop the log again.</p>
  </section>
{/if}
</div>

{#if mode === 'review' && current}<ReviewReport analysis={shownCurrent ?? current} {issues} {standing} wrong={wrongNow} />{/if}

<style>
  :global(:root) {
    --bg: #ffffff; --fg: #1d1d1f; --muted: #5f6368; --border: #e3e3e6; --hover: #f4f5f7; --focus: #1a73e8;
    --error: #c5221f; --warning: #a35200; --grid: #ececef;
    --series-1: #1a73e8; --series-2: #d93025; --series-3: #188038; --series-4: #9334e6; --series-5: #e37400;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) {
      --bg: #17181a; --fg: #e8e8ea; --muted: #a0a3a8; --border: #2e3034; --hover: #222428; --focus: #8ab4f8;
      --error: #f28b82; --warning: #fdb863; --grid: #26282c;
      --series-1: #8ab4f8; --series-2: #f28b82; --series-3: #81c995; --series-4: #c58af9; --series-5: #fcad70;
    }
  }
  /* Print is always light, whatever the screen is: redeclare every variable above with the light values (the selector is
     as specific as the dark one's, plus html, so it wins wherever the stylesheets land). The report is what prints. */
  @media print {
    :global(html:root), :global(html:root:not([data-theme='light'])) {
      --bg: #ffffff; --fg: #1d1d1f; --muted: #5f6368; --border: #e3e3e6; --hover: #f4f5f7; --focus: #1a73e8;
      --error: #c5221f; --warning: #a35200; --grid: #ececef; --go: #188038;
      --series-1: #1a73e8; --series-2: #d93025; --series-3: #188038; --series-4: #9334e6; --series-5: #e37400;
      color-scheme: light;
    }
    :global(body) { background: #ffffff; color: #1d1d1f; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    :global(#app) { max-width: none; padding: 0; }
    :global(.screen-only) { display: none !important; }
    @page { size: Letter; margin: 0.3in 0.5in; }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  :global(#app.wide) { max-width: 1280px; }
  :global(#app) { max-width: 980px; margin: 0 auto; padding: 1rem 16px 3rem; }
  :global(code) { font-family: var(--mono); font-size: 0.85em; overflow-wrap: anywhere; }
  .top.compact { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 1.25rem; }
  .top.compact .modes { margin-bottom: 0.5rem; }
  header h1 { margin: 0; font-size: 1.5rem; }
  .update { margin: 0 0 0.5rem; padding: 0.3rem 0.75rem; border: 1px solid var(--focus); border-radius: 6px; }
  .tag { margin: 0.1rem 0 1rem; color: var(--muted); }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .drop.compact { padding: 0.25rem 0.75rem; gap: 0.25rem 0.75rem; }
  /* With a log loaded the drop row shows only while a file is dragged: float it over the page so nothing moves under the pointer. */
  .drop.compact.dragging { position: fixed; top: 1rem; left: 50%; transform: translateX(-50%); z-index: 30; padding: 0.75rem 1.25rem; pointer-events: none; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); }
  .drop.compact .button { padding: 0.15rem 0.75rem; }
  .drop.dragging { border-color: var(--focus); background: var(--hover); }
  .button { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within, .button:focus-visible { outline: 2px solid var(--focus); }
  .busy { color: var(--muted); }
  .history { font-size: 0.85rem; color: var(--muted); margin: 0.75rem 0 0; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
  .history strong { color: var(--warning); }
  .link { margin-left: auto; min-height: 24px; padding: 0.2rem 0.4rem; border: none; background: none; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; }
  .problem { color: var(--error); }
  .matches { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0; }
  .matches button { display: flex; flex-direction: column; align-items: flex-start; padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  .matches button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .matches small { color: var(--muted); }
  .match-head { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.25rem 1rem; margin-top: 0.4rem; }
  .match-head .rest, .match-head .problem { grid-column: 1 / -1; }
  .rest { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.6rem; }
  .rest > .meta:last-child:not(:first-child) { flex-basis: 100%; }
  .more[open] { flex-basis: 100%; }
  .match-head .problem { margin: 0; }
  .match-head h2 { margin: 0; font-size: 1.25rem; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .choose { min-height: 28px; padding: 0.15rem 0.7rem; box-sizing: border-box; }
  .meta { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .dirty { color: var(--warning); }
  .more > summary { cursor: pointer; color: var(--muted); min-height: 24px; }
  .meta select { width: auto; max-width: 100%; font: inherit; font-size: 0.8rem; min-height: 24px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .modes { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0 0 0.75rem; }
  .modes button { padding: 0.3rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .modes button.active { color: var(--fg); border-color: var(--focus); font-weight: 600; }
  .tabs { display: flex; gap: 0.25rem; margin: 0 0 0.4rem; border-bottom: 1px solid var(--border); }
  .tabs button { padding: 0.45rem 1rem; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--focus); font-weight: 600; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .empty { margin-top: 1.5rem; }
  .empty h2 { font-size: 1.1rem; }
  .empty li { margin-bottom: 0.4rem; max-width: 75ch; }
</style>
