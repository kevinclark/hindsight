<!--
  Session view: many logs at once, grouped into sessions (an event, a practice day), with each finding's confidence
  across the matches, the rule × match grid and per-match trends. Logs are read one at a time and only a small
  summary of each is kept, so a whole event's folder fits in memory.
-->
<script lang="ts">
  import { summarizeLog, type MatchSummary } from '../session/summary.ts'
  import { PROFILE_FIT_MIN } from '../profiles/choose.ts'
  import { PROFILES, profileId } from '../profiles/index.ts'
  import { chooseRobot, chosenRobot, HOW_WORDS } from './robot-choice.ts'
  import { profilesNow } from './kept-profiles.svelte.ts'
  import { CONFIDENCE_WORDS, groupSessions, mergeFindings, rateText, ruleGrid, type Session } from '../session/session.ts'
  import { buildSessionJson } from '../session/export.ts'
  import { clearCached, fileKey, loadCached, saveCached } from '../session/cache.ts'
  import type { IssueEvent } from '../triage/history.ts'
  import { downloadText } from './download.ts'
  import Trends from './Trends.svelte'
  import SessionReport from './SessionReport.svelte'
  import { buildCard } from '../report/card.ts'
  import { cardToPngDataUrl, saveForSlack } from '../report/card-png.ts'
  import { crashedNote, sessionBase, sessionCard, sessionModel } from '../report/session-model.ts'

  let { issues, onOpen, hasSession = $bindable(false) }: { issues: Map<string, IssueEvent>; onOpen: (files: File[]) => void; hasSession?: boolean } = $props()

  let summaries = $state<MatchSummary[]>([])
  // File handles only (not their contents), so a match can be reopened in Match review.
  const files = new Map<string, File>()
  let progress = $state<{ done: number; total: number; ms: number; current: string } | null>(null)
  let problems = $state<string[]>([])
  let selectedId = $state<string | null>(null)
  // Summaries collected so far, shared by every load so two loads at once can't overwrite each other.
  const collected: MatchSummary[] = []
  let overrides = $state<Record<string, string>>(readStore('hindsight.sessionOverrides'))
  let renames = $state<Record<string, string>>(readStore('hindsight.sessionRenames'))
  let typedBatteries = $state<Record<string, string>>(readStore('hindsight.typedBatteries'))
  let heapMB = $state<number | null>(null)
  // Summaries saved in this browser, by file key (name, size, modified time): reused instead of reading a log again,
  // and restored when the page reloads. The logs themselves are never kept.
  const cache = new Map<string, MatchSummary>()
  let restored = $state<{ count: number; savedAt: string } | null>(null)
  // Summaries on the page whose log file this page doesn't have (restored after a reload, not chosen again yet).
  let withoutFile = $state(0)
  // How many summaries this browser holds, and whether saving works here (a private window or Safari from disk may refuse).
  let savedCount = $state(0)
  let saveFailed = $state(false)
  // Restoring finishes before any load reads the cache, so a folder chosen right after a reload reuses it.
  const ready = loadCached().then((saved) => {
    // One per file name (the newest), and only those read with the robot picked for that log now.
    const newest = new Map<string, (typeof saved)[number]>()
    for (const c of saved) {
      const prev = newest.get(c.summary.fileName)
      if (!prev || c.savedAt > prev.savedAt) newest.set(c.summary.fileName, c)
    }
    const usable = [...newest.values()].filter((c) => reusable(c.summary, c.summary.fileName))
    for (const c of usable) {
      cache.set(c.key, c.summary)
      if (!collected.some((s) => s.fileName === c.summary.fileName)) collected.push(c.summary)
    }
    savedCount = saved.length
    if (usable.length) {
      summaries = [...collected]
      restored = { count: usable.length, savedAt: usable.map((c) => c.savedAt).sort()[0] }
      withoutFile = collected.filter((s) => !files.has(s.fileName)).length
    }
  })
  /** Remove the copies saved in this browser; what is on the page stays. */
  async function forget() {
    await clearCached()
    cache.clear()
    savedCount = 0
    restored = null
  }
  /** A saved summary is reusable only if it was read with the robot the student picks now. */
  function reusable(s: MatchSummary | undefined, fileName: string): s is MatchSummary {
    if (!s) return false
    const chosen = chosenRobot(fileName)
    return chosen ? s.robot.how === 'chosen by you' && s.robot.profileId === profileId(chosen) : s.robot.how !== 'chosen by you'
  }

  const stored = $derived(profilesNow())
  const sessions = $derived(groupSessions(summaries, overrides, renames))
  // Selected by id, so sessions re-sorting while logs load doesn't switch what you're looking at.
  // Until one is picked, show the event (the matches that count), else the first session.
  const session = $derived((sessions.find((s) => s.id === selectedId) ?? sessions.find((s) => s.kind === 'event') ?? sessions[0]) as Session | undefined)
  const grid = $derived(session ? ruleGrid(session) : [])
  const merged = $derived(session ? mergeFindings(session) : [])
  // "Once" rows (one match only, low confidence) fold under one summary; the rest stay listed. Same order inside each.
  const listed = $derived(merged.filter((f) => f.confidence !== 'once'))
  const onceRows = $derived(merged.filter((f) => f.confidence === 'once'))
  // Rule × match rows: most matches fired first, then the worse severity, then the rules' own order.
  const SEV_RANK = { error: 0, warning: 1, info: 2 } as const
  const gridRows = $derived.by(() => {
    const rows = grid.map((r, row) => {
      const sevs = r.cells.map((c, i) => {
        if (c !== 'fired') return null
        const fs = session!.matches[i].rules[r.rule]?.findings ?? []
        // Fired with no finding listed: shown as the worst, never quietly grey.
        return fs.length ? fs.reduce((a, b) => (SEV_RANK[b.severity] < SEV_RANK[a] ? b.severity : a), fs[0].severity) : 'error'
      })
      const worst = Math.min(3, ...sevs.map((v) => (v ? SEV_RANK[v] : 3)))
      return { ...r, sevs, worst, row }
    })
    return rows.sort((a, b) => b.fired - a.fired || a.worst - b.worst || a.row - b.row)
  })
  // The robots (profiles) this session's logs were read with, and how many matches each.
  const robots = $derived.by(() => {
    const by = new Map<string, MatchSummary[]>()
    for (const m of session?.matches ?? []) by.set(m.robot.profileId, [...(by.get(m.robot.profileId) ?? []), m])
    return [...by.values()].map((ms) => ({ robot: ms[0].robot, matches: ms }))
  })
  // Logs the robot profile doesn't fit (another robot, or another year's code): their mechanism and timing findings are suspect.
  const misfits = $derived(session ? session.matches.filter((m) => m.robot.present < PROFILE_FIT_MIN * m.robot.total) : [])
  // The robot the student chose for this whole session, if every match has the same choice.
  const chosenId = $derived(session && session.matches.every((m) => m.robot.how === 'chosen by you') && robots.length === 1 ? robots[0].robot.profileId : null)
  const notes = $derived([...new Set(session ? session.matches.map((m) => m.robot.note).filter((n): n is string => !!n) : [])])

  function readStore(key: string): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(key) ?? '{}') } catch { return {} }
  }
  function writeStore(key: string, value: Record<string, string>) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: not remembered */ }
  }

  async function load(list: FileList | File[] | null) {
    await ready
    const chosen = Array.from(list ?? []).filter((f) => /\.wpilog$/i.test(f.name))
    if (chosen.length === 0) { problems = ['No .wpilog files in what you chose. To load a folder, use "Choose a folder…" (dragging a folder in only works for the files themselves).']; return }
    problems = []
    const started = performance.now()
    progress = { done: 0, total: chosen.length, ms: 0, current: '' }
    // Collect summaries in a plain list and show them every 10 logs: redrawing the whole session after every log
    // made a 160-log folder take minutes.
    const publish = () => { summaries = [...collected] }
    for (const file of chosen) {
      progress = { ...progress, current: file.name }
      await new Promise((r) => setTimeout(r, 0)) // let the page paint between logs
      try {
        const key = fileKey(file)
        const saved = cache.get(key)
        const summary = reusable(saved, file.name) ? saved : summarizeLog({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, chosenRobot(file.name), [...PROFILES, ...stored])
        if (summary && summary !== saved) {
          cache.set(key, summary)
          saveCached(key, $state.snapshot(summary) as MatchSummary).then((ok) => { if (ok) savedCount++; else saveFailed = true })
        }
        if (summary) {
          const old = collected.findIndex((s) => s.fileName === summary.fileName)
          if (old >= 0) collected.splice(old, 1)
          collected.push(summary)
          files.set(file.name, file)
        } else problems = [...problems, `${file.name}: not a .wpilog`]
      } catch (error) {
        problems = [...problems, `${file.name}: ${error instanceof Error ? error.message : error}`]
      }
      progress = { ...progress, done: progress.done + 1, ms: performance.now() - started }
      if (progress.done % 10 === 0) publish()
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      if (mem) heapMB = Math.max(heapMB ?? 0, mem.usedJSHeapSize / 2 ** 20)
    }
    publish()
    withoutFile = collected.filter((s) => !files.has(s.fileName)).length
  }

  // The student picked the robot for every log in this session: read them again with that profile.
  async function setRobot(s: Session, id: string) {
    const names = s.matches.flatMap((m) => m.pieces ?? [m.fileName])
    chooseRobot(names, id === 'auto' ? null : id)
    const have = names.map((n) => files.get(n)).filter((f): f is File => !!f)
    if (have.length < names.length) problems = ['To read these logs again with that robot, choose them again ("Choose logs…"): between visits this page keeps summaries, not logs.']
    if (have.length) await load(have)
  }

  /** Open a match in Match review. A summary restored after a reload has no file: ask for it again. */
  function open(m: MatchSummary) {
    const fs = (m.pieces ?? [m.fileName]).map((n) => files.get(n)).filter((f): f is File => !!f)
    if (fs.length) onOpen(fs)
    else problems = [`To open ${m.fileName} in Match review, choose it again ("Choose logs…"): between visits this page keeps each log's summary, not the log.`]
  }

  function moveMatch(fileName: string, label: string) {
    if (!label) { const { [fileName]: _, ...rest } = overrides; overrides = rest } else overrides = { ...overrides, [fileName]: label }
    writeStore('hindsight.sessionOverrides', overrides)
  }
  function rename(s: Session) {
    const name = window.prompt('Session name', s.label)
    if (!name) return
    renames = { ...renames, [s.id]: name.trim() }
    writeStore('hindsight.sessionRenames', renames)
  }
  function setBattery(fileName: string, id: string) {
    typedBatteries = { ...typedBatteries, [fileName]: id.trim() }
    writeStore('hindsight.typedBatteries', typedBatteries)
  }
  function download() {
    if (!session) return
    downloadText(`${sessionBase(session.label)}.session-findings.json`, JSON.stringify(buildSessionJson(session, issues, typedBatteries), null, 1))
  }
  // "Save for Slack": the phone card as a PNG, then the print dialog (Save as PDF; the title names the file).
  const cardOf = (s: Session) => buildCard(sessionCard(sessionModel(s, issues, typedBatteries)))
  let saveProblem = $state<string | null>(null)
  async function saveForSlackSession() {
    saveProblem = null
    if (!session) return
    const base = sessionBase(session.label)
    try { saveProblem = await saveForSlack(`${base}.session-report`, `${base}.session-card.png`, cardOf(session)) } catch (error) { saveProblem = `Save for Slack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Tells App.svelte that a session is selected, so print shows the session report instead of the app.
  $effect(() => { hasSession = !!session })
  // For scripts/report.ts --session: the same builders the buttons use.
  $effect(() => {
    const api = (window as unknown as { hindsight?: Record<string, unknown> }).hindsight
    if (!api) return
    api.sessionList = () => sessions.map((s) => ({ id: s.id, label: s.label, matches: s.matches.length }))
    api.selectSession = (id: string) => { selectedId = id }
    api.sessionFile = () => (session ? `${sessionBase(session.label)}.session-findings.json` : null)
    api.sessionBase = () => (session ? sessionBase(session.label) : null)
    api.sessionFindingsJson = () => (session ? JSON.stringify(buildSessionJson(session, issues, typedBatteries), null, 1) : null)
    api.sessionCardPng = async () => (session ? await cardToPngDataUrl(cardOf(session)) : null)
    api.sessionReport = () => (session ? sessionModel(session, issues, typedBatteries) : null)
  })
  function newSessionFor(fileName: string) {
    const label = window.prompt('Move this log to the session named:', '')
    if (label) moveMatch(fileName, label.trim())
  }

  /** Matches played after an issue was marked fixed, where it fired again. */
  function cameBack(key: string, matchIdx: number[]): string[] {
    const issue = issues.get(key)
    if (!issue || issue.status !== 'fixed' || !session) return []
    const fixedAt = Date.parse(issue.when)
    return matchIdx.map((i) => session.matches[i]).filter((m) => m.playedAt !== null && m.playedAt > fixedAt).map(label)
  }

  const label = (m: MatchSummary) => (m.matchLabel || m.fileName.replace(/\.wpilog$/i, '')) + (m.pieces ? ` (${m.pieces.length} logs)` : '')
  const pct = (x: number) => `${Math.round(100 * x)} %`
  // How far past the line, in words: "12 % past it", or "7× the line" when it is far past.
  const past = (margin: number) => (margin < 1 ? `${pct(margin)} past it` : `${(1 + margin).toFixed(1)}× the line`)
  const CELL = { quiet: '·', 'not checked': '–' } as const
  // The same glyphs and words as the findings list (FindingRow): shape and word carry severity when colour can't.
  const SEV_ICON = { error: '●', warning: '▲', info: '○' } as const
  const SEV_WORD = { error: 'Error', warning: 'Warning', info: 'Info' } as const
  // "Qualification 13" -> "Q13" for chart axes; a log with no match label gets its number in the list.
  const shortLabel = (m: MatchSummary, i: number) => (m.matchLabel ? m.matchLabel.replace(/^(\w)\w*\s+(\d+)$/, '$1$2') : `#${i + 1}`)
  // At most 2 decimals, without trailing zeros: 7.4, 1.2–2.1, 53.
  const fmt = (x: number) => String(+x.toFixed(Math.abs(x) >= 100 ? 0 : 2))
</script>

{#snippet row(f: (typeof merged)[number])}
  {@const back = cameBack(f.key, f.matches)}
  <li class={f.severity}>
    <span class={`chip ${f.confidence.replace(/ /g, '-')}`}>{CONFIDENCE_WORDS[f.confidence]}</span>
    <span class="title">{#if back.length}<strong class="back">Came back after a fix ({back.join(', ')})</strong> {/if}<code>{f.key}</code>: {rateText(f.matches.length, f.checkable)} ({pct(f.interval[0])}–{pct(f.interval[1])})</span>
    {#if f.measured.length}
      <span class="measured">{f.measured.map((m) => `${m.label} ${fmt(m.min)}${m.max !== m.min ? `–${fmt(m.max)}` : ''}${m.unit ? ` ${m.unit}` : ''}${m.threshold !== undefined ? ` (line ${m.threshold} ${m.unit}${m.medianMargin !== undefined ? `, ${past(m.medianMargin)}` : ''})` : ''}`).join('; ')}</span>
    {/if}
    <span class="latest">Latest: {f.title}</span>
  </li>
{/snippet}

<div class:screen-only={!!session} data-session-view>
<p class="intro">Choose a whole folder of match logs (an event, a practice day), or drop the log files here. Each log is read and summarised one at a time, so a big folder is fine. Logs are grouped into sessions; each finding says how often it showed up across them.</p>

<section class="drop" aria-label="Drop logs here" ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); load(e.dataTransfer?.files ?? null) }}>
  <label class="button">Choose a folder… <input type="file" webkitdirectory multiple onchange={(e) => load((e.currentTarget as HTMLInputElement).files)} /></label>
  <label class="button">Choose logs… <input type="file" multiple accept=".wpilog" onchange={(e) => load((e.currentTarget as HTMLInputElement).files)} /></label>
  {#if progress}
    <span class="progress" role="status">
      {progress.done} of {progress.total} logs{progress.done < progress.total ? ` · reading ${progress.current}` : ''} ·
      {(progress.ms / 1000).toFixed(1)} s{progress.done ? ` (${Math.round(progress.ms / progress.done)} ms per log)` : ''}{heapMB !== null ? ` · JS heap peak ${heapMB.toFixed(0)} MB` : ''}
    </span>
  {/if}
</section>
{#each problems as p (p)}<p class="problem">{p}</p>{/each}
{#if restored || savedCount || saveFailed}
  <p class="note">
    {#if restored}Restored {restored.count} log summar{restored.count === 1 ? 'y' : 'ies'} saved in this browser (from {new Date(restored.savedAt).toLocaleString()}).{withoutFile ? ` The logs themselves aren't kept: choose them again (${withoutFile} without a file now) to open one in Match review.` : ''}{:else if savedCount}{savedCount} log summar{savedCount === 1 ? 'y' : 'ies'} saved in this browser, so a reload keeps this session.{/if}
    {#if saveFailed} This browser won't save them (a private window, or a browser that blocks storage for pages opened from disk), so a reload will start empty.{/if}
    {#if savedCount || restored}<button class="link" onclick={forget}>Clear saved copies</button>{/if}
  </p>
{/if}

{#if sessions.length}
  <nav class="sessions" aria-label="Sessions">
    {#each sessions as s (s.id)}
      <button class:active={session?.id === s.id} onclick={() => (selectedId = s.id)}>{s.label} <small>{s.matches.length} match{s.matches.length === 1 ? '' : 'es'}</small></button>
    {/each}
  </nav>
{/if}

{#if session}
  <section class="head">
    <h2>{session.label} <button class="link" onclick={() => rename(session)}>rename</button></h2>
    <span class="actions">
      <button class="button" onclick={download}>Download for Claude</button>
      <button class="button" onclick={saveForSlackSession} title="Opens the print dialog: choose Save as PDF. Also saves a phone-sized card (PNG) to post in Slack with it.">Save for Slack</button>
    </span>
  </section>
  {#if saveProblem}<p class="problem" role="alert">{saveProblem}</p>{/if}
  {#each robots as r (r.robot.profileId)}
    <p class="note">Robot: <strong>{r.robot.name}</strong>, code as of {r.robot.code.branch} <code>{r.robot.code.sha}</code> ({HOW_WORDS[r.robot.how]}){robots.length > 1 ? ` · ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}` : ''}</p>
  {/each}
  <p class="note"><label>Robot for this session: <select onchange={(e) => setRobot(session, (e.currentTarget as HTMLSelectElement).value)}>
    <option value="auto" selected={!chosenId}>automatic (from each log)</option>
    {#each [...PROFILES, ...stored] as p (profileId(p))}<option value={profileId(p)} selected={profileId(p) === chosenId}>{profileId(p)}</option>{/each}
  </select></label></p>
  {#each notes as n (n)}<p class="note warn">{n}</p>{/each}
  {#if crashedNote(session)}<p class="note warn">{crashedNote(session)}</p>{/if}
  {#if misfits.length}
    <p class="note warn"><strong>{misfits.length} of {session.matches.length} matches don't fit their robot profile</strong>: as few as {Math.min(...misfits.map((m) => m.robot.present))} of its {misfits[0].robot.total} signals are in them. The rules about specific motors, devices, cameras and mechanisms were not run on them, and their auto and teleop lengths were measured from the logs. Add a profile for this robot, or choose one above.</p>
  {/if}
  {#each session.matches.filter((m) => m.pieces) as m (m.fileName)}
    <p class="note warn">{m.matchLabel} is in {m.pieces!.length} logs ({m.pieces!.join(', ')}): the robot program restarted during the match. They count as one match here.</p>
  {/each}
  {#each session.matches.filter((m) => m.clockNote) as m (m.fileName)}
    <p class="note warn">{label(m)}: {m.clockNote}</p>
  {/each}

  <h3>Rule × match</h3>
  <div class="grid-wrap">
    <table class="grid">
      <thead>
        <tr><th>rule</th>{#each session.matches as m (m.fileName)}<th class="match"><button class="link" title={m.fileName} onclick={() => open(m)}>{label(m)}</button></th>{/each}<th>across the session</th></tr>
      </thead>
      <tbody>
        {#each gridRows as r (r.rule)}
          <tr>
            <th scope="row"><code>{r.rule}</code></th>
            {#each r.cells as c, i (i)}
              {#if c === 'fired'}{@const sev = r.sevs[i] ?? 'error'}<td class={`cell fired ${sev}`} title={`${SEV_WORD[sev]}: fired`}><span aria-hidden="true">{SEV_ICON[sev]}</span><span class="sr">{SEV_WORD[sev]}</span></td>
              {:else}<td class={`cell ${c.replace(/ /g, '-')}`} title={c}>{CELL[c]}</td>{/if}
            {/each}
            <td class="rate">{r.checkable ? `${CONFIDENCE_WORDS[r.confidence]}: ${r.fired} of ${r.checkable}` : 'not checked'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hint">Rules that fired in the most matches come first. ● error · ▲ warning · ○ info (the worst finding the rule gave in that match) · "·" quiet · "–" not checked (signals missing, no robot profile fits the log, or the rule crashed). Click a match to open it in Match review.</p>

  <h3>Per match</h3>
  <Trends matches={session.matches} {typedBatteries} labels={session.matches.map(shortLabel)} />

  <h3>Findings across the session</h3>
  <p class="hint">Consistent: fired in most matches where it could be checked (3 or more). Intermittent: in some, or in every match of only 2 checked (too few to call consistent). Once: one match only, low confidence. The range is a 95 % confidence interval for how often it fires; "past the line" is how far the measured value went past the rule's threshold (median across matches).</p>
  <ul class="merged">
    {#each listed as f (f.key)}
      {@render row(f)}
    {/each}
  </ul>
  {#if onceRows.length}
    <details class="once-fold">
      <summary>{onceRows.length} seen {CONFIDENCE_WORDS.once.toLowerCase()}</summary>
      <ul class="merged">
        {#each onceRows as f (f.key)}
          {@render row(f)}
        {/each}
      </ul>
    </details>
  {/if}

  <h3>Matches in this session</h3>
  <div class="grid-wrap"><table class="list">
    <thead><tr><th>match</th><th>played</th><th>battery</th><th>session</th></tr></thead>
    <tbody>
      {#each session.matches as m (m.fileName)}
        <tr>
          <td>{label(m)}</td>
          <td>{m.playedAt ? new Date(m.playedAt).toLocaleString() : 'unknown'}{m.playedAtSource === 'file name' ? ' (from file name)' : ''}</td>
          <td>{#if m.batteryId}{m.batteryId} (logged){:else}<input size="6" placeholder="label" value={typedBatteries[m.fileName] ?? ''} onchange={(e) => setBattery(m.fileName, (e.currentTarget as HTMLInputElement).value)} />{/if}</td>
          <td>
            <select onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v === '__new') newSessionFor(m.fileName); else moveMatch(m.fileName, v === '__auto' ? '' : v) }}>
              <option value="" selected disabled>move to…</option>
              <option value="__auto">automatic grouping</option>
              {#each sessions.filter((s) => s.id !== session.id) as s (s.id)}<option value={s.label}>{s.label}</option>{/each}
              <option value="__new">a new session…</option>
            </select>
          </td>
        </tr>
      {/each}
    </tbody>
  </table></div>
{/if}
</div>
{#if session}<SessionReport {session} {issues} {typedBatteries} />{/if}

<style>
  .intro, .hint, .note { font-size: 0.85rem; color: var(--muted); max-width: 80ch; }
  .warn { color: var(--warning); }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .button { display: inline-block; min-height: 24px; box-sizing: border-box; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .progress { font-size: 0.85rem; color: var(--muted); }
  .problem { color: var(--error); font-size: 0.85rem; }
  .sessions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0; }
  .sessions button { min-height: 24px; padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  .sessions button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .sessions small { color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; margin-top: 1rem; }
  h2 { font-size: 1.2rem; margin: 0; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .link { border: none; background: none; color: var(--focus); font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0.2rem 0.25rem; min-height: 24px; box-sizing: border-box; }
  .merged { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
  .merged li { display: grid; grid-template-columns: 8rem 1fr; gap: 0.1rem 0.75rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  .merged .measured, .merged .latest { grid-column: 2; color: var(--muted); overflow-wrap: anywhere; }
  .merged .title { overflow-wrap: anywhere; }
  .error .title code { color: var(--error); }
  .warning .title code { color: var(--warning); }
  .back { color: var(--error); }
  .chip { justify-self: start; font-size: 0.75rem; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); height: fit-content; }
  .chip.consistent { border-color: var(--error); color: var(--error); }
  .chip.intermittent { border-color: var(--warning); color: var(--warning); }
  .chip.once { border-style: dashed; }
  .grid-wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.8rem; }
  .grid th, .grid td { padding: 0.1rem 0.5rem; text-align: center; white-space: nowrap; }
  .grid th[scope='row'], .grid thead th:first-child { text-align: left; }
  .grid thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  /* Severity colour, plus a different glyph and a word for greyscale and screen readers (WCAG 1.4.1). */
  .cell.fired { font-weight: 700; }
  .cell.fired.error { color: var(--error); }
  .cell.fired.warning { color: var(--warning); }
  .cell.fired.info { color: var(--muted); }
  .cell.not-checked { color: var(--muted); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .grid th.match { white-space: normal; min-width: 4.5rem; }
  .once-fold { margin-top: 0.5rem; }
  .once-fold summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); min-height: 24px; display: flex; align-items: center; }
  .rate { text-align: left !important; color: var(--muted); }
  .list th, .list td { text-align: left; padding: 0.15rem 1rem 0.15rem 0; }
  .list thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  input:not([type='file']), select { min-height: 24px; box-sizing: border-box; }
  input, select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; max-width: 100%; }
  @media (max-width: 640px) { .merged li { grid-template-columns: 1fr; } .merged .measured, .merged .latest { grid-column: 1; } }
</style>
