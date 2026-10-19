<!--
  Hindsight: drop a match's .wpilog (and its .dslog if you have it) and read the lint report.
  Everything runs in this page. Files never leave the computer.
-->
<script lang="ts">
  import { analyzeFiles, type Analysis, type InputFile } from './analyze.ts'
  import { buildFindingsJson, findingsFileName } from './report/findings-json.ts'
  import MatchTab from './ui/MatchTab.svelte'
  import PowerTab from './ui/PowerTab.svelte'
  import { downloadText } from './ui/download.ts'

  let analyses = $state<Analysis[]>([])
  let problems = $state<string[]>([])
  let selected = $state(0)
  let tab = $state<'match' | 'power'>('match')
  let busy = $state(false)
  let dragging = $state(false)
  let lastLoad = $state<{ files: number; readMs: number; analyzeMs: number; heapMB: number | null } | null>(null)

  const current = $derived(analyses[selected] as Analysis | undefined)

  async function load(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    busy = true
    await new Promise((r) => setTimeout(r, 30)) // let "Reading…" paint
    try {
      const started = performance.now()
      const inputs: InputFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
      const read = performance.now()
      const result = analyzeFiles(inputs)
      const done = performance.now()
      analyses = result.analyses
      problems = result.problems
      selected = 0
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      lastLoad = { files: files.length, readMs: read - started, analyzeMs: done - read, heapMB: mem ? mem.usedJSHeapSize / 2 ** 20 : null }
    } catch (error) {
      problems = [String(error)]
    } finally {
      busy = false
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    if (e.dataTransfer?.files) load(e.dataTransfer.files)
  }

  function downloadForClaude() {
    if (!current) return
    const json = JSON.stringify(buildFindingsJson(current.match, current.report), null, 1)
    downloadText(findingsFileName(current.match), json)
  }

  // For automated checks (e.g. a test page that already has File objects): window.hindsight.load(files)
  ;(window as unknown as { hindsight: object }).hindsight = {
    load,
    version: '0.1.0',
    get timings() {
      return { lastLoad, matches: analyses.map((a) => ({ file: a.match.fileName, ...a.timing, findings: a.report.findings.length })) }
    },
  }

  const fmtDuration = (a: Analysis) => (a.match.matchStart !== null && a.match.matchEnd !== null ? `${(a.match.matchEnd - a.match.matchStart).toFixed(0)} s match` : 'never enabled')
</script>

<svelte:window ondragover={(e) => { e.preventDefault(); dragging = true }} ondragleave={(e) => { if (e.relatedTarget === null) dragging = false }} ondrop={onDrop} />

<header>
  <h1>Hindsight</h1>
  <p class="tag">Lints FRC 8033 match logs. Runs in this page; your files never leave this computer.</p>
</header>

<section class="drop" class:dragging aria-busy={busy}>
  <label class="button">
    <input type="file" multiple accept=".wpilog,.dslog" onchange={(e) => load((e.currentTarget as HTMLInputElement).files ?? [])} />
    Choose logs…
  </label>
  <span>or drop a match's <code>.wpilog</code> (and its <code>.dslog</code>) anywhere on the page.</span>
  {#if busy}<span class="busy">Reading…</span>{/if}
</section>

{#each problems as p (p)}<p class="problem" role="alert">{p}</p>{/each}

{#if analyses.length > 1}
  <nav class="matches" aria-label="Loaded matches">
    {#each analyses as a, i (a.match.fileName)}
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
        <code>{current.match.fileName}</code>{#if current.match.ds}{' + '}<code>{current.match.ds.fileName}</code>{/if} ·
        {fmtDuration(current)} · code <code>{current.match.build.sha.slice(0, 7) || '?'}</code> on {current.match.build.branch || '?'}
        {#if /uncommitted/i.test(current.match.build.dirty)}<strong class="dirty">(uncommitted changes)</strong>{/if}
      </p>
    </div>
    <button class="button" onclick={downloadForClaude} title="Saves findings.json: findings, evidence and short data windows, for analysis with Claude">Download for Claude</button>
  </section>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === 'match'} class:active={tab === 'match'} onclick={() => (tab = 'match')}>Match</button>
    <button role="tab" aria-selected={tab === 'power'} class:active={tab === 'power'} onclick={() => (tab = 'power')}>Power</button>
  </div>

  <main>
    {#if tab === 'match'}<MatchTab analysis={current} />{:else}<PowerTab analysis={current} />{/if}
  </main>

  <footer>
    Read {current.match.log.entries.size} signals, {current.match.log.recordCount.toLocaleString()} records ·
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
  </section>
{/if}

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
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  :global(#app) { max-width: 980px; margin: 0 auto; padding: 1rem 16px 3rem; }
  :global(code) { font-family: var(--mono); font-size: 0.85em; }
  header h1 { margin: 0; font-size: 1.5rem; }
  .tag { margin: 0.1rem 0 1rem; color: var(--muted); }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .drop.dragging { border-color: var(--focus); background: var(--hover); }
  .button { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within, .button:focus-visible { outline: 2px solid var(--focus); }
  .busy { color: var(--muted); }
  .problem { color: var(--error); }
  .matches { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0; }
  .matches button { display: flex; flex-direction: column; align-items: flex-start; padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  .matches button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .matches small { color: var(--muted); }
  .match-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 0.5rem 1rem; margin-top: 1.25rem; }
  .match-head h2 { margin: 0; font-size: 1.25rem; }
  .meta { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
  .dirty { color: var(--warning); }
  .tabs { display: flex; gap: 0.25rem; margin: 1rem 0 0.75rem; border-bottom: 1px solid var(--border); }
  .tabs button { padding: 0.45rem 1rem; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--focus); font-weight: 600; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .empty { margin-top: 1.5rem; }
  .empty h2 { font-size: 1.1rem; }
  .empty li { margin-bottom: 0.4rem; max-width: 75ch; }
</style>
