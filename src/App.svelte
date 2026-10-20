<!--
  Hindsight: drop a match's .wpilog (and its .dslog if you have it) and read the lint report.
  Everything runs in this page. Files never leave the computer.
-->
<script lang="ts">
  import { analyzeFiles, type Analysis, type InputFile } from './analyze.ts'
  import { buildFindingsJson, findingsFileName } from './report/findings-json.ts'
  import MatchTab from './ui/MatchTab.svelte'
  import PowerTab from './ui/PowerTab.svelte'
  import LimitsTab from './ui/LimitsTab.svelte'
  import Wizard from './ui/Wizard.svelte'
  import SessionView from './ui/SessionView.svelte'
  import SnapshotView from './ui/SnapshotView.svelte'
  import ForesightView from './ui/ForesightView.svelte'
  import ReviewReport from './ui/ReviewReport.svelte'
  import { buildCard } from './report/card.ts'
  import { cardToPngDataUrl, saveForSlack } from './report/card-png.ts'
  import { reviewCard, reviewModel } from './report/review-model.ts'
  import { downloadText } from './ui/download.ts'
  import { VERSION } from './version.ts'
  import { currentStatus, HISTORY_FILE_NAME, mergeHistory, parseHistory, serializeHistory, type HistoryEvent, type IssueStatus, type PitCheckEvent } from './triage/history.ts'
  import type { Finding } from './rules/types.ts'
  import { PROFILES, profileId } from './profiles/index.ts'
  import { chooseRobot, chosenRobot, HOW_WORDS } from './ui/robot-choice.ts'

  // Every file dropped so far, so a .dslog dropped after its .wpilog still finds its match. "Clear" empties it.
  let inputs: InputFile[] = []
  let analyses = $state<Analysis[]>([])
  let problems = $state<string[]>([])
  let selected = $state(0)
  let tab = $state<'match' | 'power' | 'limits'>('match')
  // Review match logs, a whole session of them, the limits wizard, or a robot snapshot (device settings and faults).
  let mode = $state<'review' | 'session' | 'wizard' | 'snapshot' | 'foresight'>('review')

  // From the Session view: open one match's log (every piece, if the robot program restarted during it) in Match review.
  async function openFromSession(files: File[]) {
    mode = 'review'
    tab = 'match'
    await load(files)
  }
  let busy = $state(false)
  let dragging = $state(false)
  let lastLoad = $state<{ files: number; readMs: number; analyzeMs: number; heapMB: number | null } | null>(null)

  const current = $derived(analyses[selected] as Analysis | undefined)

  // Known issues: kept in this browser between visits, and saved to / loaded from hindsight-history.jsonl.
  const STORE = 'hindsight.history'
  let history = $state<HistoryEvent[]>(readStoredHistory())
  let unsaved = $state(false)
  const issues = $derived(currentStatus(history))

  function readStoredHistory(): HistoryEvent[] {
    try { return parseHistory(localStorage.getItem(STORE) ?? '').events } catch { return [] }
  }
  function keep(events: HistoryEvent[], changed: boolean) {
    history = events
    if (changed) unsaved = true
    try { localStorage.setItem(STORE, serializeHistory(events)) } catch { /* private window: the file is the only copy */ }
  }
  function mark(finding: Finding, status: IssueStatus, note: string) {
    const label = current ? `${current.match.event} ${current.match.matchLabel}`.trim() : ''
    keep([...history, { type: 'issue', key: finding.key, status, note, when: new Date().toISOString(), match: label || undefined }], true)
  }
  function saveHistory() {
    downloadText(HISTORY_FILE_NAME, serializeHistory(history), 'application/x-ndjson')
    unsaved = false
  }

  async function load(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    busy = true
    await new Promise((r) => setTimeout(r, 30)) // let "Reading…" paint
    try {
      const started = performance.now()
      const added: InputFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
      // The same file dropped twice replaces the first copy.
      const sameFile = (a: InputFile, b: InputFile) => a.name === b.name && a.bytes.length === b.bytes.length
      inputs = [...inputs.filter((old) => !added.some((n) => sameFile(old, n))), ...added]
      const read = performance.now()
      const result = analyzeFiles(inputs, chosenRobot)
      const done = performance.now()
      analyses = result.analyses
      problems = result.problems
      if (result.history.length) keep(mergeHistory(history, result.history), false)
      const newest = result.analyses.findIndex((a) => added.some((f) => f.name === a.match.fileName))
      selected = Math.max(0, newest)
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      lastLoad = { files: files.length, readMs: read - started, analyzeMs: done - read, heapMB: mem ? mem.usedJSHeapSize / 2 ** 20 : null }
    } catch (error) {
      problems = [String(error)]
    } finally {
      busy = false
    }
  }

  // The student picked another robot for this log: run it again with that profile.
  function setRobot(id: string) {
    if (!current) return
    chooseRobot([current.match.fileName], id === 'auto' ? null : id)
    const file = current.match.fileName
    const result = analyzeFiles(inputs, chosenRobot)
    analyses = result.analyses
    selected = Math.max(0, analyses.findIndex((a) => a.match.fileName === file))
  }

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
    if (!current) return
    const json = JSON.stringify(buildFindingsJson(current.match, current.report, issues), null, 1)
    downloadText(findingsFileName(current.match), json)
  }

  // "Save for Slack": the browser's print dialog (Save as PDF; the title names the file), then the phone card as a PNG.
  const reviewCardOf = (a: Analysis) => buildCard(reviewCard(reviewModel(a, issues)))
  function saveForSlackReview() {
    if (!current) return
    const base = current.match.fileName.replace(/\.wpilog$/i, '')
    return saveForSlack(`${base}.report`, `${base}.card.png`, reviewCardOf(current))
  }
  // Print shows the report instead of the app, in Match review (with a log loaded) and Foresight; other views print as they are.
  const reportable = $derived((mode === 'review' && !!current) || mode === 'foresight')

  // For automated checks (e.g. a test page that already has File objects): window.hindsight.load(files)
  ;(window as unknown as { hindsight: object }).hindsight = {
    load,
    version: VERSION,
    // For scripts/report.ts: the same builders the buttons use, for the log in view.
    findingsJson: () => (current ? JSON.stringify(buildFindingsJson(current.match, current.report, issues), null, 1) : null),
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

<header class:screen-only={reportable}>
  <h1>Hindsight</h1>
  <p class="tag">Lints FRC robot match logs. Runs in this page; your files never leave this computer.</p>
</header>

<nav class="modes" class:screen-only={reportable} aria-label="Mode">
  <button class:active={mode === 'review'} onclick={() => (mode = 'review')}>Match review</button>
  <button class:active={mode === 'session'} onclick={() => (mode = 'session')}>Session</button>
  <button class:active={mode === 'wizard'} onclick={() => (mode = 'wizard')}>Limits wizard</button>
  <button class:active={mode === 'snapshot'} onclick={() => (mode = 'snapshot')}>Robot snapshot</button>
  <button class:active={mode === 'foresight'} onclick={() => (mode = 'foresight')}>Foresight</button>
</nav>

<!-- All the views stay mounted and only the active one shows, so switching never loses a loaded session,
     the matches in review, the wizard's progress, or a snapshot. -->
<div hidden={mode !== 'wizard'} class:screen-only={reportable}><Wizard matches={analyses} /></div>
<div hidden={mode !== 'snapshot'} class:screen-only={reportable}><SnapshotView /></div>
<div hidden={mode !== 'foresight'}>
  <ForesightView {history} onPitCheck={(e: PitCheckEvent) => keep([...history, e], true)} />
  {#if unsaved}<p class="history screen-only">A pit check was added to the team's history in this browser · <button class="link" onclick={saveHistory}>Save {HISTORY_FILE_NAME}</button></p>{/if}
</div>
<div hidden={mode !== 'session'} class:screen-only={reportable}><SessionView {issues} onOpen={openFromSession} /></div>
<div hidden={mode !== 'review'} class:screen-only={reportable}>
<section class="drop" class:dragging aria-busy={busy}>
  <label class="button">
    <input type="file" multiple accept=".wpilog,.dslog,.jsonl" onchange={(e) => { const input = e.currentTarget as HTMLInputElement; load(input.files ?? []); input.value = '' }} />
    Choose logs…
  </label>
  <span>or drop a match's <code>.wpilog</code> (and its <code>.dslog</code>, and the team's <code>{HISTORY_FILE_NAME}</code>) anywhere on the page.</span>
  {#if busy}<span class="busy">Reading…</span>{/if}
  {#if analyses.length}<button class="link" onclick={clearAll}>Clear all</button>{/if}
</section>

{#each problems as p (p)}<p class="problem" role="alert">{p}</p>{/each}

{#if history.length}
  <p class="history">
    Known issues: {issues.size} tracked{#if unsaved}{' · '}<strong>changes not saved to a file yet</strong>{/if}
    <button class="link" onclick={saveHistory}>Save {HISTORY_FILE_NAME}</button>
  </p>
{/if}

{#if analyses.length > 1}
  <nav class="matches" aria-label="Loaded matches">
    {#each analyses as a, i (i)}
      {@const errors = a.report.findings.filter((f) => f.severity === 'error').length}
      <button class:active={i === selected} onclick={() => (selected = i)}>
        <span>{a.match.matchLabel || a.match.fileName}</span>
        <small>{errors} error{errors === 1 ? '' : 's'}</small>
      </button>
    {/each}
  </nav>
{/if}

{#if current}
  <section class="match-head">
    <div>
      <h2>{current.match.event ? `${current.match.event} ` : ''}{current.match.matchLabel || 'Match'}</h2>
      <p class="meta">
        <code>{current.match.fileName}</code>{#each current.match.ds as d (d.fileName)}{' + '}<code>{d.fileName}</code>{/each} ·
        {fmtDuration(current)} · code <code>{current.match.build.sha.slice(0, 7) || '?'}</code> on {current.match.build.branch || '?'}
        {#if /uncommitted/i.test(current.match.build.dirty)}<strong class="dirty">(uncommitted changes)</strong>{/if}
      </p>
      <p class="meta">
        Robot: <strong>{current.match.profile.name}</strong>, code as of {current.match.profile.code.branch} <code>{current.match.profile.code.sha}</code>
        ({HOW_WORDS[current.match.profileChoice.how]}) ·
        <label>use <select onchange={(e) => setRobot((e.currentTarget as HTMLSelectElement).value)}>
          <option value="auto" selected={current.match.profileChoice.how !== 'chosen by you'}>automatic</option>
          {#each PROFILES as p (profileId(p))}<option value={profileId(p)} selected={current.match.profileChoice.how === 'chosen by you' && profileId(p) === profileId(current.match.profile)}>{profileId(p)}</option>{/each}
        </select></label>
      </p>
      {#if current.match.profileChoice.note}<p class="meta dirty">{current.match.profileChoice.note}</p>{/if}
    </div>
    <span class="actions">
      <button class="button" onclick={downloadForClaude} title="Saves findings.json: findings, evidence and short data windows, for analysis with Claude">Download for Claude</button>
      <button class="button" onclick={saveForSlackReview} title="Opens the print dialog: choose Save as PDF. Also saves a phone-sized card (PNG) to post in Slack with it.">Save for Slack</button>
    </span>
  </section>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === 'match'} class:active={tab === 'match'} onclick={() => (tab = 'match')}>Match</button>
    <button role="tab" aria-selected={tab === 'power'} class:active={tab === 'power'} onclick={() => (tab = 'power')}>Power</button>
    <button role="tab" aria-selected={tab === 'limits'} class:active={tab === 'limits'} onclick={() => (tab = 'limits')}>Limits</button>
  </div>

  <main>
    {#if tab === 'match'}<MatchTab analysis={current} {issues} onMark={mark} />{:else if tab === 'power'}<PowerTab analysis={current} />{:else}<LimitsTab analysis={current} />{/if}
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
      <li>Drop the <code>.wpilog</code> here. Add the Driver Station's <code>.dslog</code> for the same match if you have it (on the DS laptop in <code>C:\Users\Public\Documents\FRC\Log Files</code>).</li>
      <li>Read the <strong>Match</strong> tab worst first: red cost or nearly cost a match, amber is a margin eroding, grey is context.</li>
      <li>Open the <strong>Power</strong> tab for brownouts and battery health.</li>
    </ol>
    <p class="meta">Matches opened here aren't kept when the page reloads (the Session view keeps each log's summary, not the log): drop the log again.</p>
  </section>
{/if}
</div>

{#if mode === 'review' && current}<ReviewReport analysis={current} {issues} />{/if}

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
  :global(#app) { max-width: 980px; margin: 0 auto; padding: 1rem 16px 3rem; }
  :global(code) { font-family: var(--mono); font-size: 0.85em; overflow-wrap: anywhere; }
  header h1 { margin: 0; font-size: 1.5rem; }
  .tag { margin: 0.1rem 0 1rem; color: var(--muted); }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .drop.dragging { border-color: var(--focus); background: var(--hover); }
  .button { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within, .button:focus-visible { outline: 2px solid var(--focus); }
  .busy { color: var(--muted); }
  .history { font-size: 0.85rem; color: var(--muted); margin: 0.75rem 0 0; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
  .history strong { color: var(--warning); }
  .link { margin-left: auto; border: none; background: none; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; }
  .problem { color: var(--error); }
  .matches { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0; }
  .matches button { display: flex; flex-direction: column; align-items: flex-start; padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  .matches button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .matches small { color: var(--muted); }
  .match-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 0.5rem 1rem; margin-top: 1.25rem; }
  .match-head h2 { margin: 0; font-size: 1.25rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .meta { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .dirty { color: var(--warning); }
  .meta select { width: auto; max-width: 100%; font: inherit; font-size: 0.8rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .modes { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0 0 0.75rem; }
  .modes button { padding: 0.3rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .modes button.active { color: var(--fg); border-color: var(--focus); font-weight: 600; }
  .tabs { display: flex; gap: 0.25rem; margin: 1rem 0 0.75rem; border-bottom: 1px solid var(--border); }
  .tabs button { padding: 0.45rem 1rem; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--focus); font-weight: 600; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .empty { margin-top: 1.5rem; }
  .empty h2 { font-size: 1.1rem; }
  .empty li { margin-bottom: 0.4rem; max-width: 75ch; }
</style>
