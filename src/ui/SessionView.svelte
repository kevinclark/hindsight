<!--
  Session view: many logs at once, grouped into sessions (an event, a practice day), with each finding's confidence
  across the matches, the rule × match grid and per-match trends. Logs are read one at a time and only a small
  summary of each is kept, so a whole event's folder fits in memory.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { askText } from './ask-text.svelte.ts'
  import { summarizeLogWithCode, summaryRobot, type MatchSummary } from '../session/summary.ts'
  import CodeFolderControl from './CodeFolderControl.svelte'
  import { codeFolder } from './code-folder.svelte.ts'
  import { PROFILES, profileId } from '../profiles/index.ts'
  import { chooseRobot, chosenRobot, HOW_WORDS } from './robot-choice.ts'
  import { profilesNow } from './kept-profiles.svelte.ts'
  import { teamNow } from './team-setting.svelte.ts'
  import { robotChoices } from './robot-list.ts'
  import { codeSpec, draftOffers, type LibraryLink } from '../hub/session-files.ts'
  import RobotOptions from './RobotOptions.svelte'
  import { CONFIDENCE_WORDS, groupSessions, mergeFindings, rateText, ruleGrid, type Session } from '../session/session.ts'
  import { buildSessionJson } from '../session/export.ts'
  import { clearCached, fileKey, loadCached, saveCached } from '../session/cache.ts'
  import { staleNote } from '../session/stale.ts'
  import { changeText, diffFindings, snapshotFindings, type FindingChange, type FindingSnapshot } from '../session/changes.ts'
  import { VERSION } from '../version.ts'
  import { boardState, type HistoryEvent, type Triage } from '../triage/history.ts'
  import { scopeOf } from '../board/model.ts'
  import { saveForClaude } from './export-preview.svelte.ts'
  import { sessionWithMarks } from '../triage/track-record.ts'
  import Trends from './Trends.svelte'
  import { shortMatchLabel } from './match-label.ts'
  import { loggingChanges, neverLogged, type StateRun } from '../coverage/coverage.ts'
  import { STATE_ICON, STATE_WORDS } from '../coverage/words.ts'
  import SessionReport from './SessionReport.svelte'
  import { buildCard } from '../report/card.ts'
  import { cardToPngDataUrl, saveForSlack } from '../report/card-png.ts'
  import { allMarked, crashedNote, gridCells, marksText, misfitNotes, sessionBase, sessionCard, sessionModel } from '../report/session-model.ts'
  import { sinks, stoppedFiring, stoppedText } from '../session/stopped.ts'
  import { hub } from '../hub/bridge.ts'
  import { REFUSED_WORDS, blankEventClusters, clockOffsetText, identifyEvents, type ResolvedEvent } from '../tba/identify.ts'
  import { tbaGetter, tbaHasKey, tbaMissing, tbaTeam } from './tba-setting.svelte.ts'
  import BoardView from './BoardView.svelte'
  import BoardQueuePrint from './BoardQueuePrint.svelte'
  import { sessionSchedule } from '../tba/session-schedule.ts'
  import type { ScheduledMatch } from '../tba/schedule.ts'
  import type { QueueSheet } from '../board/sheets.ts'
  import TbaFields from './TbaFields.svelte'
  import ModeLine from './ModeLine.svelte'
  import { chooseMode, renameSession, sessionNames } from './session-names.svelte.ts'
  import { modeLine, modeOf } from '../session/mode.ts'
  import { leftOutLine, leftOutWhy, runsLine, runsSummary, runsText, trendSet } from '../session/runs.ts'

  // `marks`: the team's history (known, fixed and "not a real problem" marks). `findLogs` (desktop app): the library's
  // copies of logs by name, for summaries restored without their file. `linksFor` (desktop app): the library's code links for
  // logs by name; `onDraft` opens the profile builder on one.
  let { marks, history = [], onBoard, onOpen, findLogs, linksFor, onDraft, hasSession = $bindable(false), sessionsOut = $bindable([]) }: { marks: Triage; history?: HistoryEvent[]; onBoard?: (build: (device: string, history: HistoryEvent[]) => HistoryEvent[]) => void; onOpen: (files: File[]) => void; findLogs?: (names: string[]) => Promise<File[]>; linksFor?: (names: string[]) => Promise<LibraryLink[]>; onDraft?: (link: LibraryLink) => void; hasSession?: boolean; sessionsOut?: Session[] } = $props()
  const issues = $derived(marks.issues)

  let summaries = $state<MatchSummary[]>([])
  // File handles only (not their contents), so a match can be reopened in Match review.
  const files = new Map<string, File>()
  let progress = $state<{ done: number; total: number; ms: number; current: string } | null>(null)
  let problems = $state<string[]>([])
  let selectedId = $state<string | null>(null)
  // Summaries collected so far, shared by every load so two loads at once can't overwrite each other.
  const collected: MatchSummary[] = []
  let overrides = $state<Record<string, string>>(readStore('hindsight.sessionOverrides'))
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
  // Summaries on the page that an older Hindsight read (restored after an update), by log file name: shown, but
  // not reused as if current. "Read again" replaces them.
  let stale = $state<Record<string, { version?: string; savedAt: string }>>({})
  // Saved summaries too old to draw (another shape): only counted.
  let hiddenOld = $state<Set<string>>(new Set())
  // Restoring finishes before any load reads the cache, so a folder chosen right after a reload reuses it.
  const ready = loadCached().then((saved) => {
    // One per file name (the newest), and only those read with the robot picked for that log now.
    const newest = new Map<string, (typeof saved.current)[number]>()
    for (const c of [...saved.current, ...saved.stale]) {
      const prev = newest.get(c.summary.fileName)
      if (!prev || c.savedAt > prev.savedAt) newest.set(c.summary.fileName, c)
    }
    const usable = [...newest.values()].filter((c) => sameRobot(c.summary, c.summary.fileName))
    const oldRead = new Set(saved.stale.map((c) => c.key))
    for (const c of usable) {
      if (oldRead.has(c.key)) stale[c.summary.fileName] = { version: c.version, savedAt: c.savedAt }
      else cache.set(c.key, c.summary)
      if (!collected.some((s) => s.fileName === c.summary.fileName)) collected.push(c.summary)
    }
    savedCount = saved.current.length + saved.stale.length
    hiddenOld = new Set(saved.otherShape.map((c) => c.summary.fileName))
    if (usable.length) {
      summaries = [...collected]
      restored = { count: usable.length, savedAt: usable.map((c) => c.savedAt).sort()[0] }
      withoutFile = collected.filter((s) => !files.has(s.fileName)).length
    }
  })
  /** Remove the copies saved in this browser; what is on the page stays. */
  async function forget() {
    loadGen++
    await clearCached()
    cache.clear()
    savedCount = 0
    restored = null
  }
  /**
   * A saved summary is reusable for a log chosen now only if it was read with the robot the student picks now and the
   * code folder chosen now. (After a reload, summaries are restored whatever folder they were read with: each is right
   * for the folder it names, and the remembered folder may not be readable yet.)
   */
  function reusable(s: MatchSummary | undefined, fileName: string): s is MatchSummary {
    return sameRobot(s, fileName) && (s.codeFolder ?? null) === (codeFolder.chosen?.name ?? null)
  }
  function sameRobot(s: MatchSummary | undefined, fileName: string): s is MatchSummary {
    if (!s) return false
    const chosen = chosenRobot(fileName)
    return chosen ? s.robot.how === 'chosen by you' && s.robot.profileId === profileId(chosen) : s.robot.how !== 'chosen by you'
  }

  const stored = $derived(profilesNow())
  // Which event The Blue Alliance says each blank-event on-field log belongs to (src/tba/identify.ts). Filled in after the
  // logs are read, from the saved copy when offline; until then, and with no key or team, the grouping is the plain one.
  let found = $state.raw<ReadonlyMap<string, ResolvedEvent>>(new Map())
  let lookupProblem = $state('')
  $effect(() => {
    const logs = summaries, get = tbaGetter(), team = tbaTeam()
    lookupProblem = ''
    if (!get || team === null || blankEventClusters(logs).length === 0) { found = new Map(); return }
    let stale = false
    void identifyEvents(logs, team, get).then((r) => {
      if (stale) return
      found = r.byFile
      const lost = r.clusters.filter((c) => c.why === 'unreachable').length
      if (r.clusters.some((c) => c.why === 'refused')) lookupProblem = REFUSED_WORDS
      else if (lost) lookupProblem = `The Blue Alliance could not be reached for ${lost} group${lost === 1 ? '' : 's'} of logs with no event name, and no saved copy covers them.`
    })
    return () => { stale = true }
  })
  const sessions = $derived(groupSessions(summaries, overrides, sessionNames(), found))
  // Selected by id, so sessions re-sorting while logs load doesn't switch what you're looking at.
  // Until one is picked, show the event (the matches that count), else the first session.
  const session = $derived((sessions.find((s) => s.id === selectedId) ?? sessions.find((s) => s.kind === 'event') ?? sessions[0]) as Session | undefined)
  // The session as the team's marks show it (Match review shows the same): a red that a "not a real problem" mark on
  // another match of the event demotes is amber, with the reason. Findings, the grid's colours and the exports use it.
  const shown = $derived(session ? sessionWithMarks(session, marks) : undefined)
  const grid = $derived(session ? ruleGrid(session) : [])

  // In event mode the Session view opens on the issue board (ADR 4); the findings, grid and trends are one click away.
  let boardTab = $state<'board' | 'findings'>('board')
  const eventMode = $derived(!!session && modeOf(session) === 'event' && !!onBoard)
  const showBoard = $derived(eventMode && boardTab === 'board')
  // The board leads the first screen: with it showing, the chooser, saved-copies line, event names and session buttons fold to one line that opens them.
  let chromeOpen = $state(false)
  let printQueue = $state<{ sheet: QueueSheet; title: string } | null>(null)
  // The team's schedule at this event, for the next match, the gaps and the deferral points (ADR 6). Read again only when the
  // session's on-field matches, event or Blue Alliance settings change, not on every summary that lands.
  let schedule = $state.raw<ScheduledMatch[] | null>(null)
  let scheduleNote = $state<string | null>(null)
  const scheduleSig = $derived(eventMode && session ? `${session.id}|${session.event?.key ?? ''}|${session.matches.filter((m) => m.onField).map((m) => m.matchLabel).join(',')}|${tbaTeam()}|${tbaHasKey()}` : '')
  $effect(() => {
    if (!scheduleSig) { schedule = null; scheduleNote = null; return }
    const s = untrack(() => session)!
    const [get, team] = [tbaGetter(), tbaTeam()]
    if (!get || team === null) { schedule = null; scheduleNote = null; return }
    let stale = false
    void (async () => {
      try {
        const got = await sessionSchedule(s, team, get)
        if (stale) return
        schedule = got.schedule
        scheduleNote = got.note
      } catch (e) {
        if (!stale) { schedule = null; scheduleNote = `No schedule: ${e instanceof Error ? e.message : String(e)}` }
      }
    })()
    return () => { stale = true }
  })
  const merged = $derived(shown ? mergeFindings(shown) : [])
  // "Once" rows (one match only, low confidence) fold under one summary; the rest stay listed. Same order inside each.
  // A row that came back after a fix stays listed whatever its confidence: it is the news, never folded away.
  const folds = (f: (typeof merged)[number]) => f.confidence === 'once' && cameBack(f.key, f.matches).length === 0
  // Whether each finding stopped firing (session/stopped.ts): the student's fixed mark, or "not seen since".
  const stopped = $derived(new Map(merged.map((f) => [f.key, stoppedFiring(shown!, f, issues.get(f.key))])))
  // Potentially fixed warnings (never errors) sit below the live findings, in their own list.
  const sunk = (f: (typeof merged)[number]) => sinks(stopped.get(f.key) ?? null, f.severity)
  // Marked "not a real problem" in every match it fired in: listed apart, like Match review's known issues.
  const filedRows = $derived(merged.filter(allMarked))
  const unfiled = $derived(merged.filter((f) => !allMarked(f)))
  const live = $derived(unfiled.filter((f) => !sunk(f)))
  const listed = $derived(live.filter((f) => !folds(f)))
  const onceRows = $derived(live.filter(folds))
  const stoppedRows = $derived(unfiled.filter(sunk))
  // What the fold holds, counted from its rows: "43 errors, 4 warnings".
  const onceHolds = $derived((['error', 'warning', 'info'] as const).map((sev) => [sev, onceRows.filter((f) => f.severity === sev).length] as const).filter(([, n]) => n > 0).map(([sev, n]) => (sev === 'info' ? `${n} info` : `${n} ${sev}${n === 1 ? '' : 's'}`)).join(', '))
  // Rule × match rows: most matches fired first, then the worse severity, then the rules' own order.
  const SEV_RANK = { error: 0, warning: 1, info: 2 } as const
  const gridRows = $derived.by(() => {
    const rows = grid.map((r, row) => {
      // A cell marked not a real problem keeps its severity's shape, greyed, and doesn't sort the row up.
      const cells = gridCells(shown!, r.rule)
      const worst = Math.min(3, ...cells.map((c) => (c.severity && !c.marked ? SEV_RANK[c.severity] : 3)))
      return { ...r, gridCells: cells, worst, row }
    })
    return rows.sort((a, b) => b.fired - a.fired || a.worst - b.worst || a.row - b.row)
  })
  // Practice is judged by run (ADR 8): the runs in the session's logs, and the logs the Trends leave out (never enabled, or only runs under 10 s).
  const practice = $derived(!!session && modeOf(session) === 'practice')
  const unitWord = (isPractice: boolean, many: boolean) => (isPractice ? (many ? 'logs' : 'log') : many ? 'matches' : 'match')
  const trendInfo = $derived(session ? trendSet(session) : null)
  const leftOutText = $derived(practice && session ? leftOutLine(runsSummary(session.matches)) : '')
  // Pit runs: logs not on the field, on an event's days. Not matches: they have their own grid and are in no count above.
  const pitRuns = $derived(session?.pitRuns ?? [])
  const pitGrid = $derived.by(() => {
    if (!session || pitRuns.length === 0) return []
    const pit = { ...session, matches: pitRuns }
    return ruleGrid(pit).map((r) => ({ ...r, gridCells: gridCells(pit, r.rule) })).filter((r) => r.fired > 0)
      .sort((a, b) => b.fired - a.fired)
  })
  const pitTime = (m: MatchSummary) => (m.playedAt ? new Date(m.playedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : m.fileName)
  // Signals that appeared, vanished or changed between matches (by build), and those missing from every match.
  const changes = $derived(session ? loggingChanges(session.matches) : [])
  const missingAll = $derived(session ? neverLogged(session.matches) : [])
  const withLogging = $derived(session ? session.matches.filter((m) => m.logging).length : 0)
  // The robots this session's logs are from, and how many matches each: a guess that doesn't fit goes by the log's code name.
  const robots = $derived.by(() => {
    const by = new Map<string, MatchSummary[]>()
    for (const m of session?.matches ?? []) { const { key } = summaryRobot(m.robot); by.set(key, [...(by.get(key) ?? []), m]) }
    return [...by.values()].map((ms) => ({ robot: ms[0].robot, ...summaryRobot(ms[0].robot), matches: ms }))
  })
  // The profiles this session's logs name (not a guess that doesn't fit): the code folder's suggestion and the robot list's own robots.
  const namedRobots = $derived(robots.filter((r) => r.named).map((r) => r.robot.profileId))
  // The robot the student chose for this whole session, if every match has the same choice.
  const chosenId = $derived(session && session.matches.every((m) => m.robot.how === 'chosen by you') && robots.length === 1 ? robots[0].robot.profileId : null)
  const notes = $derived([...new Set(session ? session.matches.map((m) => m.robot.note).filter((n): n is string => !!n) : [])])

  // Logs whose robot was only guessed (by signals, or by the code's name) and whose library record links them to a GitHub repo:
  // one offer per repo and commit, to draft a profile from that code.
  let codeLinks = $state.raw<LibraryLink[]>([])
  // The effect depends on this string, so it runs again only when the set of guessed logs changes, not on every change to the session.
  const guessedNames = $derived((session?.matches ?? []).filter((m) => m.robot.how === 'signals' || m.robot.how === 'codebase').flatMap((m) => m.pieces ?? [m.fileName]).sort().join('\n'))
  $effect(() => {
    const names = guessedNames ? guessedNames.split('\n') : []
    if (!linksFor || names.length === 0) { codeLinks = []; return }
    let stale = false
    void linksFor(names).then((found) => { if (!stale) codeLinks = found }).catch(() => { if (!stale) codeLinks = [] })
    return () => { stale = true }
  })
  const offers = $derived(draftOffers(codeLinks))

  /** Every log file in a session, counting the pieces of a match recorded in several logs. */
  const logsOf = (s: Session) => [...s.matches, ...(s.pitRuns ?? [])].flatMap((m) => m.pieces ?? [m.fileName])
  const staleShown = $derived(summaries.filter((m) => stale[m.fileName]).map((m) => stale[m.fileName]))
  const sessionIsStale = $derived(!!session && logsOf(session).some((n) => stale[n]))
  const staleText = $derived(staleNote(staleShown, hiddenOld.size))

  function readStore(key: string): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(key) ?? '{}') } catch { return {} }
  }
  function writeStore(key: string, value: Record<string, string>) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: not remembered */ }
  }

  // Loads run one after another, so a re-read for a new code folder starts once the logs being read have all landed.
  // Each load keeps the number current when it was asked for; New session bumps it, so loads running or still
  // queued then stop quietly.
  let loadGen = 0
  let queue: Promise<void> = Promise.resolve()
  function load(list: FileList | File[] | null, opts: { fresh?: boolean } = {}): Promise<void> {
    const picked = Array.from(list ?? [])
    const gen = loadGen
    queue = queue.then(() => loadNow(picked, gen, opts)).catch((error) => { problems = [...problems, String(error)] })
    return queue
  }

  /** From the Library: read these logs into the session, as if chosen with "Choose logs…", and show the session that holds them. */
  export async function addFiles(list: File[]): Promise<void> {
    await load(list)
    const shown = sessionHolding(list.map((f) => f.name))
    if (shown) selectedId = shown.id
  }
  /** The session holding most of these logs. */
  function sessionHolding(names: string[]): Session | undefined {
    const holds = (x: Session) => logsOf(x).filter((n) => names.includes(n)).length
    return sessions.reduce<Session | undefined>((best, x) => (holds(x) > (best ? holds(best) : 0) ? x : best), undefined)
  }
  /** These logs' files: those chosen on this visit, then (desktop app) the library's copies. */
  async function filesFor(names: string[]): Promise<File[]> {
    const have = names.map((n) => files.get(n)).filter((f): f is File => !!f)
    const missing = names.filter((n) => !files.has(n))
    return missing.length && findLogs ? [...have, ...(await findLogs(missing))] : have
  }

  async function loadNow(list: File[], gen: number, { fresh = false }: { fresh?: boolean } = {}) {
    await ready
    if (gen !== loadGen) return
    const chosen = Array.from(list ?? []).filter((f) => /\.wpilog$/i.test(f.name))
    if (chosen.length === 0) { problems = ['No .wpilog files in what you chose. To load a folder, use "Choose a folder…" (dragging a folder in only works for the files themselves).']; return }
    problems = []
    const started = performance.now()
    progress = { done: 0, total: chosen.length, ms: 0, current: '' }
    // Collect summaries in a plain list and show them every 10 logs: redrawing the whole session after every log
    // made a 160-log folder take minutes.
    const publish = () => { summaries = [...collected] }
    const saving: Promise<void>[] = []
    for (const file of chosen) {
      progress = { ...progress, current: file.name }
      await new Promise((r) => setTimeout(r, 0)) // let the page paint between logs
      if (gen !== loadGen) return
      try {
        const key = fileKey(file)
        const saved = cache.get(key)
        const reuse = !fresh && reusable(saved, file.name)
        const bytes = reuse ? null : new Uint8Array(await file.arrayBuffer())
        if (gen !== loadGen) return
        const summary = reuse ? saved : await summarizeLogWithCode({ name: file.name, bytes: bytes! }, codeFolder.current, codeFolder.chosen?.name ?? null, chosenRobot(file.name), [...PROFILES, ...stored])
        if (gen !== loadGen) return
        if (summary && summary !== saved) {
          cache.set(key, summary)
          saving.push(saveCached(key, $state.snapshot(summary) as MatchSummary).then((ok) => { if (!ok) saveFailed = true }))
        }
        if (summary) {
          delete stale[summary.fileName]
          if (hiddenOld.has(summary.fileName)) hiddenOld = new Set([...hiddenOld].filter((n) => n !== summary.fileName))
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
    await Promise.all(saving)
    if (gen !== loadGen) return
    await recountSaved()
  }

  /** How many summaries this browser holds that a reload brings back (not the too-old ones), read from the store. */
  async function recountSaved() {
    const saved = await loadCached()
    savedCount = saved.current.length + saved.stale.length
  }
  /** A load is running: New session and Read again wait for it. */
  const loading = $derived(!!progress && progress.done < progress.total)
  const folded = $derived(eventMode && !chromeOpen && !loading)

  /** Start over: clear the summaries on the page and saved in this browser. What the student wrote down stays. */
  async function newSession() {
    if (loading) return
    const n = summaries.length
    if (!window.confirm(`Start a new session? This clears the ${n} log summar${n === 1 ? 'y' : 'ies'} on this page and saved in this browser. Moved logs, session names, battery ids and known-issue marks are kept.`)) return
    await clearCached()
    cache.clear()
    files.clear()
    collected.length = 0
    summaries = []
    selectedId = null
    progress = null
    problems = []
    restored = null
    withoutFile = 0
    savedCount = 0
    saveFailed = false
    heapMB = null
    stale = {}
    hiddenOld = new Set()
    reread = null
    pendingReread = null
  }

  // What the last "Read again" changed, for the session it was run on (until dismissed or a new session starts).
  let reread = $state<{ sessionId: string; changes: FindingChange[]; dismissed: boolean; note: string | null } | null>(null)
  // A "Read again" waiting for the student to choose the folder, with the findings as they stood when it was pressed.
  let pendingReread: { names: string[]; before: FindingSnapshot[]; count: number; found: File[] } | null = null
  let rereadInput: HTMLInputElement | undefined = $state()

  /**
   * Read every log of this session again with this Hindsight, ignoring the saved summaries, and see what changed. Logs
   * this page has no file for come from the library (desktop app), else from a folder the student chooses.
   */
  async function readAgain(s: Session) {
    if (loading) return
    const names = logsOf(s)
    const before = snapshotFindings(mergeFindings(s))
    const found = await filesFor(names)
    if (found.length === names.length) void rereadLogs(names, before, s.matches.length, found)
    else {
      // The button press is the click the browser needs to open the folder chooser (still in force: the library answers in milliseconds).
      pendingReread = { names, before, count: s.matches.length, found }
      rereadInput?.click()
    }
  }
  async function rereadChosen(list: FileList | null) {
    const pending = pendingReread
    pendingReread = null
    if (pending) await rereadLogs(pending.names, pending.before, pending.count, [...pending.found, ...Array.from(list ?? [])])
    if (rereadInput) rereadInput.value = ''
  }
  async function rereadLogs(names: string[], before: FindingSnapshot[], matchCount: number, chosen: File[]) {
    const picked = new Map(chosen.map((f) => [f.name, f]))
    const use = names.map((n) => picked.get(n) ?? files.get(n)).filter((f): f is File => !!f)
    if (use.length === 0) { problems = ["None of this session's logs were in what you chose, so nothing was read again."]; return }
    restored = null
    await load(use, { fresh: true })
    const missing = names.filter((n) => !picked.has(n) && !files.has(n))
    if (missing.length) problems = [...problems, `${missing.length} of this session's logs were not in what you chose, so they were not read again: ${missing.join(', ')}.`]
    const after = sessionHolding(names)
    if (!after) return
    selectedId = after.id
    const note = after.matches.length === matchCount ? null : `These logs are now in ${after.label}; the comparison covers that whole session.`
    reread = { sessionId: after.id, changes: diffFindings(before, snapshotFindings(mergeFindings(after))), dismissed: false, note }
  }

  // The student picked the robot for every log in this session: read them again with that profile.
  async function setRobot(s: Session, id: string) {
    const names = logsOf(s)
    chooseRobot(names, id === 'auto' ? null : id)
    const have = await filesFor(names)
    if (have.length < names.length) problems = ['To read these logs again with that robot, choose them again ("Choose logs…"): between visits this page keeps summaries, not logs.']
    if (have.length) await load(have)
  }

  // A code folder chosen (or forgotten): read again the logs this page has, so the limit findings use it.
  let seenFolder = codeFolder.version
  $effect(() => {
    if (codeFolder.version === seenFolder) return
    seenFolder = codeFolder.version
    const have = [...files.values()]
    if (have.length) load(have)
  })

  /** Open a match in Match review. A summary restored after a reload has no file: the library's copy, else ask for it again. */
  async function open(m: MatchSummary) {
    const fs = await filesFor(m.pieces ?? [m.fileName])
    if (fs.length) onOpen(fs)
    else problems = [`To open ${m.fileName} in Match review, choose it again ("Choose logs…"): between visits this page keeps each log's summary, not the log.`]
  }

  function moveMatch(fileName: string, label: string) {
    if (!label) { const { [fileName]: _, ...rest } = overrides; overrides = rest } else overrides = { ...overrides, [fileName]: label }
    writeStore('hindsight.sessionOverrides', overrides)
  }
  async function rename(s: Session) {
    const name = (await askText('Session name', s.label))?.trim()
    if (!name) return
    renameSession(s.id, name)
  }
  function setBattery(fileName: string, id: string) {
    typedBatteries = { ...typedBatteries, [fileName]: id.trim() }
    writeStore('hindsight.typedBatteries', typedBatteries)
  }
  const changesFor = (s: Session) => (reread && reread.sessionId === s.id ? reread.changes : undefined)
  async function download() {
    if (!session) return
    // Lists what is inside first (ADR 5); the file is saved only on Save.
    await saveForClaude(`${sessionBase(session.label)}.session-findings.json`, buildSessionJson(shown!, issues, typedBatteries, changesFor(session), { states: boardState(history), scope: scopeOf(shown!) }))
  }
  // "Save for Slack": the phone card as a PNG, then the print dialog (Save as PDF; the title names the file).
  // `s` as the team's marks show it (`shown`).
  const cardOf = (s: Session) => buildCard(sessionCard(sessionModel(s, issues, typedBatteries)))
  let saveProblem = $state<string | null>(null)
  async function saveForSlackSession() {
    saveProblem = null
    if (!session) return
    const base = sessionBase(session.label)
    try { saveProblem = await saveForSlack(`${base}.session-report`, `${base}.session-card.png`, cardOf(shown!)) } catch (error) { saveProblem = `Save for Slack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Tells App.svelte that a session is selected, so print shows the session report instead of the app.
  $effect(() => { hasSession = !!session })
  // Bound out to App, which finds the open match's session to fold the findings that fire in every match.
  $effect(() => { sessionsOut = sessions })
  // For scripts/report.ts --session: the same builders the buttons use.
  $effect(() => {
    const api = (window as unknown as { hindsight?: Record<string, unknown> }).hindsight
    if (!api) return
    api.sessionList = () => sessions.map((s) => ({ id: s.id, label: s.label, matches: s.matches.length }))
    api.selectSession = (id: string) => { selectedId = id }
    api.sessionFile = () => (session ? `${sessionBase(session.label)}.session-findings.json` : null)
    api.sessionBase = () => (session ? sessionBase(session.label) : null)
    api.sessionFindingsJson = () => (session ? JSON.stringify(buildSessionJson(shown!, issues, typedBatteries, changesFor(session)), null, 1) : null)
    api.sessionCardPng = async () => (shown ? await cardToPngDataUrl(cardOf(shown)) : null)
    api.sessionReport = () => (shown ? sessionModel(shown, issues, typedBatteries) : null)
  })
  async function newSessionFor(fileName: string) {
    const label = (await askText('Move this log to the session named:', ''))?.trim()
    if (label) moveMatch(fileName, label)
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
  // "Qualification 13" -> "Q13" for column headers and chart axes (full label in the title); no match label -> "#3".
  const shortLabel = (m: MatchSummary, i: number) => shortMatchLabel(m.matchLabel, i)
  const builds = (r: StateRun) => {
    const [a, b] = [r.first.build?.sha || '?', r.last.build?.sha || '?']
    return a === b ? `build ${a}` : `builds ${a}–${b}`
  }
  const span = (r: StateRun) => (r.matches === 1 ? label(r.first) : `${label(r.first)} to ${label(r.last)}, ${r.matches} ${unitWord(practice, true)}`)
  // At most 2 decimals, without trailing zeros: 7.4, 1.2–2.1, 53.
  const fmt = (x: number) => String(+x.toFixed(Math.abs(x) >= 100 ? 0 : 2))
</script>

{#snippet row(f: (typeof merged)[number])}
  {@const back = cameBack(f.key, f.matches)}
  {@const marked = marksText(shown!, f)}
  {@const stop = stopped.get(f.key)}
  <li class={f.severity} class:filed={allMarked(f)}>
    <span class="lead"><span class="sev"><span aria-hidden="true">{SEV_ICON[f.severity]}</span> {SEV_WORD[f.severity]}</span><span class={`chip ${f.confidence.replace(/ /g, '-')}`}>{CONFIDENCE_WORDS[f.confidence]}</span></span>
    <span class="title">{#if back.length}<strong class="back">Came back after a fix ({back.join(', ')})</strong> {/if}<code>{f.key}</code>: {rateText(f.matches.length, f.checkable, practice ? 'log' : 'match')} ({pct(f.interval[0])}–{pct(f.interval[1])})</span>
    {#if f.measured.length}
      <span class="measured">{f.measured.map((m) => `${m.label} ${fmt(m.min)}${m.max !== m.min ? `–${fmt(m.max)}` : ''}${m.unit ? ` ${m.unit}` : ''}${m.threshold !== undefined ? ` (line ${m.threshold} ${m.unit}${m.medianMargin !== undefined ? `, ${past(m.medianMargin)}` : ''})` : ''}`).join('; ')}</span>
    {/if}
    {#if marked}<span class="marked">↳ {marked}</span>{/if}
    {#if stop}<span class="stopped" class:sunk={sunk(f)} data-stopped>{stoppedText(shown!, stop, f)}</span>{/if}
    <span class="latest">Latest: {f.title}</span>
  </li>
{/snippet}

<div class:screen-only={!!session} data-session-view>
{#if folded && session}
  <p class="oneline" data-folded>{session.matches.length + (session.pitRuns?.length ?? 0)} logs · event {session.label.replace(/^Event\s+/, '')} · <button class="link" onclick={() => (chromeOpen = true)}>Change logs…</button></p>
{:else}
{#if eventMode && chromeOpen}<p class="oneline"><button class="link" onclick={() => (chromeOpen = false)}>Fold the log chooser away</button></p>{/if}
<p class="intro">Choose a whole folder of match logs (an event, a practice day), or drop the log files here. Each log is read and summarised one at a time, so a big folder is fine. Logs are grouped into sessions; each finding says how often it showed up across them.</p>

<section class="drop" aria-label="Drop logs here" ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); load(e.dataTransfer?.files ?? null) }}>
  <label class="button">Choose a folder… <input type="file" webkitdirectory multiple onchange={(e) => load((e.currentTarget as HTMLInputElement).files)} /></label>
  <label class="button">Choose logs… <input type="file" multiple accept=".wpilog" onchange={(e) => load((e.currentTarget as HTMLInputElement).files)} /></label>
  <CodeFolderControl suggest={session ? [...PROFILES, ...stored].find((p) => profileId(p) === namedRobots[0])?.code ?? null : undefined} linked={!namedRobots.length && offers.length ? codeSpec(offers[0].link) : undefined} />
  {#if summaries.length}<button class="button" disabled={loading} onclick={newSession} title="Clears the log summaries on this page and saved in this browser. Moved logs, session names, battery ids and known-issue marks are kept.">New session</button>{/if}
  <input type="file" webkitdirectory multiple hidden data-reread-input bind:this={rereadInput} onchange={(e) => rereadChosen((e.currentTarget as HTMLInputElement).files)} />
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
    {#if restored}Restored {restored.count} log summar{restored.count === 1 ? 'y' : 'ies'} saved in this browser (from {new Date(restored.savedAt).toLocaleString()}).{withoutFile && !findLogs ? ` The logs themselves aren't kept: choose them again (${withoutFile} without a file now) to open one in Match review.` : ''}{:else if savedCount}{savedCount} log summar{savedCount === 1 ? 'y' : 'ies'} saved in this browser, so a reload keeps this session.{/if}
    {#if saveFailed} This browser won't save them (a private window, or a browser that blocks storage for pages opened from disk), so a reload will start empty.{/if}
    {#if savedCount || restored}<button class="link" onclick={forget}>Clear saved copies</button>{/if}
  </p>
{/if}

{#if staleText}<p class="note warn" data-stale-note>{staleText}</p>{/if}

{#if !hub()}<TbaFields />{/if}
{#if lookupProblem}<p class="note warn">{lookupProblem}</p>{/if}

{/if}
{#if sessions.length && !folded}
  <nav class="sessions" aria-label="Sessions">
    {#each sessions as s (s.id)}
      <button class:active={session?.id === s.id} onclick={() => (selectedId = s.id)}>{s.label} <small>{modeOf(s) === 'practice' ? `${s.matches.length} log${s.matches.length === 1 ? '' : 's'}` : `${s.matches.length} match${s.matches.length === 1 ? '' : 'es'}`}{s.pitRuns?.length ? `, ${s.pitRuns.length} pit run${s.pitRuns.length === 1 ? '' : 's'}` : ''}</small></button>
    {/each}
  </nav>
{/if}

{#if session}
  {#if !folded || !showBoard}<section class="head">
    <h2>{session.label} <button class="link" onclick={() => rename(session)}>rename</button></h2>
    <span class="actions">
      <button class="button" disabled={loading} class:prominent={sessionIsStale} onclick={() => readAgain(session)} title={`Reads this session's logs again with this Hindsight, with the robot chosen for each now, and shows what changed. If the page no longer has the logs, ${findLogs ? 'it reads the library\'s copies' : 'it asks for the folder'}.`}>Read again</button>
      <button class="button" onclick={download}>Download for Claude</button>
      <button class="button" onclick={saveForSlackSession} title="Opens the print dialog: choose Save as PDF. Also saves a phone-sized card (PNG) to post in Slack with it.">Save for Slack</button>
    </span>
  </section>{/if}
  <ModeLine text={modeLine(session)} mode={modeOf(session)} byHand={!!session.modeByHand} onChange={(m) => chooseMode(session.id, m)} hint="Changes how this session's logs are grouped and counted (matches or logs, pit runs, trends). Each log is judged from its own field data." />
  {#if eventMode}
    <div class="tabs" role="tablist" aria-label="Event view">
      <button role="tab" aria-selected={boardTab === 'board'} class:active={boardTab === 'board'} onclick={() => (boardTab = 'board')}>Board</button>
      <button role="tab" aria-selected={boardTab === 'findings'} class:active={boardTab === 'findings'} onclick={() => (boardTab = 'findings')}>Findings, grid and trends</button>
    </div>
  {/if}
  {#if showBoard}
    <BoardView session={shown!} {history} {marks} {schedule} {scheduleNote} profiles={[...PROFILES, ...stored]} onWrite={onBoard!} bind:printOut={printQueue} />
  {:else}
  {#if practice}<p class="note" data-runs-summary>{runsLine(runsSummary(session.matches))} A practice day is judged by run, not by match: each log counts once in the grid and the trends, however many runs it holds.</p>{/if}
  {#if session.event}<p class="note" data-event-note>The Blue Alliance says this was {session.event.name}{#if session.event.by === 'date'}{' '}<strong>(guess)</strong>{/if} ({session.event.key}), {session.event.start} to {session.event.end}: {session.event.matched} of the {session.event.of} qualification numbers in these logs are on the team's list there{session.event.by === 'date' ? ' (several events held as many; the robot clock chose, so this is a guess)' : ''}.{session.event.clockOffsetDays ? ` The robot clock is ${clockOffsetText(session.event.clockOffsetDays).replace('robot clock ', '')}.` : ''} {session.event.fromCache ? 'From a saved copy' : 'Fetched'} {new Date(session.event.fetchedAt).toLocaleString()}.</p>{/if}
  {#if saveProblem}<p class="problem" role="alert">{saveProblem}</p>{/if}
  {#if reread && reread.sessionId === session.id && !reread.dismissed}
    <section class="changed" data-reread-changes>
      {#if reread.note}<p class="note">{reread.note}</p>{/if}
      {#if reread.changes.length === 0}
        <p class="note">Read again with Hindsight {VERSION}: no finding changed. <button class="link" onclick={() => (reread!.dismissed = true)}>Dismiss</button></p>
      {:else}
        <h3>What changed when these logs were read again (Hindsight {VERSION}) <button class="link" onclick={() => (reread!.dismissed = true)}>Dismiss</button></h3>
        <ul class="changes">
          {#each reread.changes as c (c.key)}
            <li class={c.severity}><span aria-hidden="true">{SEV_ICON[c.severity]}</span> <span class="sr">{SEV_WORD[c.severity]}: </span>{changeText(c)}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
  {#each robots as r (r.key)}
    <p class="note">Robot: <strong>{r.name}</strong>{#if !r.named}, no profile is for this robot{:else}, code as of {r.robot.code.branch} <code>{r.robot.code.sha}</code> ({HOW_WORDS[r.robot.how]}){/if}{robots.length > 1 ? ` · ${r.matches.length} ${unitWord(practice, r.matches.length !== 1)}` : ''}</p>
  {/each}
  {#if onDraft}{#each offers as { link: l, logs, total, refs } (l.code.repo)}
    <p class="note">This robot's code is <code>{l.code.repo}</code> {l.code.linkedBy === 'sha' && l.code.sha ? `at ${l.code.sha.slice(0, 7)}` : `(named by the log; its commit isn't on GitHub, so the branch is used)`}{refs > 1 ? ` (${logs} of these ${total} logs ran it; ${refs} commits in all)` : ''}. <button class="button" onclick={() => onDraft(l)}>Draft a profile from it</button></p>
  {/each}{/if}
  <p class="note"><label>Robot for this session: <select onchange={(e) => setRobot(session, (e.currentTarget as HTMLSelectElement).value)}>
    <option value="auto" selected={!chosenId}>automatic (from each log)</option>
    <RobotOptions groups={robotChoices(PROFILES, stored, teamNow(), namedRobots)} selectedId={chosenId} />
  </select></label></p>
  {#each notes as n (n)}<p class="note warn">{n}</p>{/each}
  {#if crashedNote(session)}<p class="note warn">{crashedNote(session)}</p>{/if}
  {#each misfitNotes(session) as n (n.lead)}<p class="note warn"><strong>{n.lead}</strong>: {n.rest.replace(/\.$/, ', or choose one above.')}</p>{/each}
  {#each session.matches.filter((m) => m.pieces) as m (m.fileName)}
    <p class="note warn">{m.matchLabel} is in {m.pieces!.length} logs ({m.pieces!.join(', ')}): the robot program restarted during the match. They count as one match here.</p>
  {/each}
  {#each session.matches.filter((m) => m.clockNote) as m (m.fileName)}
    <p class="note warn">{label(m)}: {m.clockNote}</p>
  {/each}

  <h3>Rule × {practice ? 'log' : 'match'}</h3>
  <div class="grid-wrap">
    <table class="grid">
      <thead>
        <tr><th>rule</th>{#each session.matches as m, i (m.fileName)}<th class="match"><button class="link" title={`${label(m)} · ${m.fileName}`} aria-label={label(m)} onclick={() => open(m)}>{shortLabel(m, i)}</button></th>{/each}<th>across the session</th></tr>
      </thead>
      <tbody>
        {#each gridRows as r (r.rule)}
          <tr>
            <th scope="row"><code>{r.rule}</code></th>
            {#each r.cells as c, i (i)}
              {#if c === 'fired'}{@const cell = r.gridCells[i]}{@const sev = cell.severity ?? 'error'}{@const markedNote = cell.marked ? ', marked not a real problem' : ''}<td class={`cell fired ${sev}`} class:filed={cell.marked} title={`${SEV_WORD[sev]}: fired${markedNote}`}><span aria-hidden="true">{SEV_ICON[sev]}</span><span class="sr">{SEV_WORD[sev]}{markedNote}</span></td>
              {:else}<td class={`cell ${c.replace(/ /g, '-')}`} title={c}>{CELL[c]}</td>{/if}
            {/each}
            <td class="rate">{r.checkable ? `${CONFIDENCE_WORDS[r.confidence]}: ${r.fired} of ${r.checkable}` : 'not checked'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="hint">Rules that fired in the most {practice ? 'logs' : 'matches'} come first. ● error · ▲ warning · ○ info (the worst finding the rule gave in that {practice ? 'log' : 'match'}; grey when the team marked it not a real problem there) · "·" quiet · "–" not checked (signals missing, no robot profile fits the log, or the rule crashed). Click a {practice ? 'log' : 'match'} to open it in Match review.</p>

  {#if pitRuns.length}
    <h3>Pit runs on this event's days</h3>
    <p class="hint" data-pit-runs>{pitRuns.length} log{pitRuns.length === 1 ? '' : 's'} not on the field, played on a day this event had matches (pit runs). They are not matches: the grid above, the match count and the confidence below leave them out. Rules that fired in at least one are shown here{pitGrid.length ? '' : '; none did'}.</p>
    <p class="hint" data-pit-runs-summary>{runsLine(runsSummary(pitRuns))}{#if leftOutLine(runsSummary(pitRuns))}{' '}{leftOutLine(runsSummary(pitRuns)).replace('left out of trends', 'not in any trend (pit runs never are)')}.{/if}</p>
    {#if pitGrid.length}
      <div class="grid-wrap"><table class="grid" data-pit-grid>
        <thead><tr><th>rule</th>{#each pitRuns as m (m.fileName)}<th class="match"><button class="link" title={`${label(m)} · ${m.fileName}`} aria-label={`Pit run ${pitTime(m)}`} onclick={() => open(m)}>{pitTime(m)}</button></th>{/each}<th>pit runs</th></tr></thead>
        <tbody>
          {#each pitGrid as r (r.rule)}
            <tr>
              <th scope="row"><code>{r.rule}</code></th>
              {#each r.cells as c, i (i)}
                {#if c === 'fired'}{@const cell = r.gridCells[i]}{@const sev = cell.severity ?? 'error'}<td class={`cell fired ${sev}`} title={`${SEV_WORD[sev]}: fired in the pit run`}><span aria-hidden="true">{SEV_ICON[sev]}</span><span class="sr">{SEV_WORD[sev]}</span></td>
                {:else}<td class={`cell ${c.replace(/ /g, '-')}`} title={c}>{CELL[c]}</td>{/if}
              {/each}
              <td class="rate">fired in {r.fired} of {r.checkable}</td>
            </tr>
          {/each}
        </tbody>
      </table></div>
    {/if}
  {/if}

  <h3>Per {trendInfo!.unit}</h3>
  {#if leftOutText}
    <details class="once-fold" data-left-out>
      <summary>{leftOutText}</summary>
      <p class="hint">A log that was never enabled, or whose runs are all under 10 s, shows no margin or rate, so it is listed (with its runs, below) but not drawn here.</p>
      <ul class="changes">{#each trendInfo!.leftOut as x (x.log.fileName)}<li>{label(x.log)}: {x.why}{x.log.runs?.count ? ` (${runsText(x.log)})` : ''}</li>{/each}</ul>
    </details>
  {/if}
  <Trends matches={trendInfo!.logs} unit={trendInfo!.unit} {typedBatteries} labels={trendInfo!.logs.map(shortLabel)} onOpen={open} />

  <h3>Findings across the session</h3>
  <p class="hint">Consistent: fired in most {practice ? 'logs' : 'matches'} where it could be checked (3 or more). Intermittent: in some, or in every one of only 2 checked (too few to call consistent). Once: one {practice ? 'log' : 'match'} only, low confidence. The range is a 95 % confidence interval for how often it fires; "past the line" is how far the measured value went past the rule's threshold (median across {practice ? 'logs' : 'matches'}).</p>
  <ul class="merged">
    {#each listed as f (f.key)}
      {@render row(f)}
    {/each}
  </ul>
  {#if onceRows.length}
    <details class="once-fold">
      <summary>{onceRows.length} seen {CONFIDENCE_WORDS.once.toLowerCase()} · {onceHolds}</summary>
      <ul class="merged">
        {#each onceRows as f (f.key)}
          {@render row(f)}
        {/each}
      </ul>
    </details>
  {/if}
  {#if stoppedRows.length}
    <h4 class="stopped-head" data-stopped-list>Stopped firing: potentially fixed ({stoppedRows.length})</h4>
    <p class="hint">Not seen in the later matches, and a run that clean rarely happens with no fix (1 time in 20 or less). Only a student's fixed mark says "fixed": the log can't see a pit repair. Errors stay in the list above whatever this says.</p>
    <ul class="merged">
      {#each stoppedRows as f (f.key)}
        {@render row(f)}
      {/each}
    </ul>
  {/if}
  {#if filedRows.length}
    <details class="once-fold filed-fold">
      <summary>{filedRows.length} marked not a real problem in every {practice ? 'log' : 'match'} {filedRows.length === 1 ? 'it' : 'they'} fired in</summary>
      <ul class="merged">
        {#each filedRows as f (f.key)}
          {@render row(f)}
        {/each}
      </ul>
    </details>
  {/if}

  <h3>Logging across the session</h3>
  {#if withLogging === 0}
    <p class="hint">Read these logs again (choose the folder) to see which signals each match logged.</p>
  {:else}
    <p class="hint">Signals the checks need whose state changed from one {practice ? 'log' : 'match'} to the next, in the order the {practice ? 'logs' : 'matches'} were played, with the code build each ran. Open a {practice ? 'log' : 'match'}'s Logging tab for what each one guards.{withLogging < session.matches.length ? ` ${session.matches.length - withLogging} {practice ? 'logs' : 'matches'} were read before Hindsight kept this and are left out.` : ''}</p>
    {#if changes.length === 0}
      <p>No signal appeared or vanished between matches.</p>
    {:else}
      <ul class="changes">
        {#each changes as c (c.key ?? c.what)}
          <li>
            <strong>{c.what}</strong>{#if c.key}{' '}<code>{c.key}</code>{/if}:
            {#each c.runs as r, i (i)}{i ? ' → ' : ''}<span class="run">{STATE_ICON[r.state]} {STATE_WORDS[r.state]} in {span(r)} ({builds(r)})</span>{/each}
          </li>
        {/each}
      </ul>
    {/if}
    {#if missingAll.length}
      <p class="note">Not in any match ({missingAll.length}): {missingAll.map((s) => s.what).join(', ')}.</p>
    {/if}
  {/if}

  <h3>{practice ? 'Logs' : 'Matches'} in this session</h3>
  <div class="grid-wrap"><table class="list">
    <thead><tr><th>{practice ? 'log' : 'match'}</th><th>played</th><th>runs</th><th>battery</th><th>session</th></tr></thead>
    <tbody>
      {#each [...session.matches.map((m) => [m, false] as const), ...pitRuns.map((m) => [m, true] as const)] as [m, pit] (m.fileName)}
        <tr>
          <td>{label(m)}{#if pit}{' '}<span class="pit">pit run</span>{/if}</td>
          <td>{m.playedAt ? new Date(m.playedAt).toLocaleString() : 'unknown'}{m.playedAtSource === 'file name' ? ' (from file name)' : ''}</td>
          <td data-runs>{runsText(m)}{#if practice && leftOutWhy(m)}{' '}<span class="pit">not in trends</span>{/if}</td>
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
{/if}
</div>
{#if printQueue}<BoardQueuePrint sheet={printQueue.sheet} title={printQueue.title} />{:else if shown}<SessionReport session={shown} {issues} {typedBatteries} />{/if}

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
  .oneline { margin: 0.2rem 0; font-size: 0.85rem; color: var(--muted); }
  .tabs { display: flex; gap: 0.25rem; margin: 0.6rem 0 0.2rem; border-bottom: 1px solid var(--border); }
  .tabs button { min-height: 28px; padding: 0.45rem 1rem; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--focus); font-weight: 600; }
  .sessions button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
  .pit { font-size: 0.75rem; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .sessions small { color: var(--muted); }
  .button.prominent { border-color: var(--warning); color: var(--warning); font-weight: 600; }
  .changed h3 { margin-top: 1rem; }
  .changed .error { color: var(--error); }
  .changed .warning { color: var(--warning); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; margin-top: 1rem; }
  h2 { font-size: 1.2rem; margin: 0; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  .link { border: none; background: none; color: var(--focus); font: inherit; font-size: 0.85rem; cursor: pointer; padding: 0.2rem 0.25rem; min-height: 24px; box-sizing: border-box; }
  .merged { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
  .merged li { display: grid; grid-template-columns: 8rem 1fr; gap: 0.1rem 0.75rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
  .merged .measured, .merged .latest, .merged .marked { grid-column: 2; color: var(--muted); overflow-wrap: anywhere; }
  /* Stopped firing: the text carries it (no colour of its own); bold when it is what put the row below the live ones. */
  .merged .stopped { grid-column: 2; overflow-wrap: anywhere; }
  .merged .stopped.sunk { font-weight: 600; }
  .stopped-head { font-size: 0.9rem; margin: 1rem 0 0.1rem; }
  /* Marked not a real problem in every match it fired in: muted like Match review's known issues; the words still say its severity. */
  .merged .title { overflow-wrap: anywhere; }
  .merged .title code { font-family: var(--mono); font-size: 0.8rem; color: var(--muted); }
  .lead { display: flex; flex-direction: column; align-items: flex-start; gap: 0.2rem; }
  .lead .sev { font-weight: 600; white-space: nowrap; }
  .error .lead .sev { color: var(--error); }
  .warning .lead .sev { color: var(--warning); }
  .info .lead .sev { color: var(--muted); }
  .back { color: var(--error); }
  .chip { justify-self: start; font-size: 0.75rem; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); height: fit-content; }
  .chip.once { border-style: dashed; }
  .grid-wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.8rem; }
  .changes { padding-left: 1.1rem; font-size: 0.85rem; }
  .changes li { margin-bottom: 0.3rem; overflow-wrap: anywhere; }
  .run { white-space: normal; }
  .grid th, .grid td { padding: 0.1rem 0.5rem; text-align: center; white-space: nowrap; }
  .grid th[scope='row'], .grid thead th:first-child { text-align: left; }
  .grid thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  /* Severity colour, plus a different glyph and a word for greyscale and screen readers (WCAG 1.4.1). */
  .cell.fired { font-weight: 700; }
  .cell.fired.error { color: var(--error); }
  .cell.fired.warning { color: var(--warning); }
  .cell.fired.info { color: var(--muted); }
  .cell.not-checked, .cell.fired.filed { color: var(--muted); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .grid th.match { padding-left: 0.2rem; padding-right: 0.2rem; }
  .grid th.match .link { min-width: 24px; }
  .once-fold { margin-top: 0.5rem; }
  .once-fold summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); min-height: 24px; display: flex; align-items: center; }
  .rate { text-align: left !important; color: var(--muted); }
  .list th, .list td { text-align: left; padding: 0.15rem 1rem 0.15rem 0; }
  .list thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  input:not([type='file']), select { min-height: 24px; box-sizing: border-box; }
  input, select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; max-width: 100%; }
  @media (max-width: 640px) { .merged li { grid-template-columns: 1fr; } .merged .measured, .merged .latest, .merged .marked, .merged .stopped { grid-column: 1; } }
</style>
