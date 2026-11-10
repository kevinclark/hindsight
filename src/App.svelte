<!--
  Hindsight: drop a match's .wpilog (and its .dslog if you have it) and read the lint report.
  Everything runs in this page. Files never leave the computer.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { analyzeFilesWithCode, withPowerMaps, type Analysis, type InputFile } from './analyze.ts'
  import { attachHoot } from './hoot/attach.ts'
  import type { HootCached, HootReading } from './hoot/types.ts'
  import { isUncommitted } from './match/git-dirty.ts'
  import { hasPin } from './profiles/pin.ts'
  import { buildFindingsJson, findingsFileName } from './report/findings-json.ts'
  import MatchTab from './ui/MatchTab.svelte'
  import Menu from './ui/Menu.svelte'
  import AskText from './ui/AskText.svelte'
  import ExportPreview from './ui/ExportPreview.svelte'
  import { saveForClaude } from './ui/export-preview.svelte.ts'
  import PowerTab from './ui/PowerTab.svelte'
  import PowerMap from './ui/PowerMap.svelte'
  import { openPowerMap, setMapHistory, setMapWriter } from './ui/power-map-bridge.svelte.ts'
  import LimitsTab from './ui/LimitsTab.svelte'
  import LoggingTab from './ui/LoggingTab.svelte'
  import DevicesTab from './ui/DevicesTab.svelte'
  import Wizard from './ui/Wizard.svelte'
  import SessionView from './ui/SessionView.svelte'
  import { standingKeys, type Session } from './session/session.ts'
  import SnapshotView from './ui/SnapshotView.svelte'
  import ForesightView from './ui/ForesightView.svelte'
  import NowView from './ui/NowView.svelte'
  import UpdateChip from './ui/UpdateChip.svelte'
  import { todaySignal } from './ui/today-signal.svelte.ts'
  import type { Place } from './now/now.ts'
  import { dateText } from './session/day.ts'
  import LibraryView from './ui/LibraryView.svelte'
  import PhoneLibrary from './ui/PhoneLibrary.svelte'
  import { backfillEvents, readSkipped, writeSkipped } from './hub/event-backfill.ts'
  import { eventLabel, orderEvents, phoneEvent, pickEvent, pickedEvent, type EventInfo } from './phone/event-choice.ts'
  import { teamEvents } from './tba/api.ts'
  import { summarizeLogWithCode } from './session/summary.ts'
  import type { OpenedFile } from './hub/browser-hub.ts'
  import { hub, phone, LibraryFile, readBeside } from './hub/bridge.ts'
  import { keepHistory } from './triage/keeper.ts'
  import SummaryReview from './ui/SummaryReview.svelte'
  import TbaFields from './ui/TbaFields.svelte'
  import { tbaGetter, tbaTeam } from './ui/tba-setting.svelte.ts'
  import { ANALYZER_HASH, eventLines, eventLogNames, latestEventSession } from './hub/event-publish.ts'
  import { analyzerHashOf, analyzerId, serializeEventLine } from './hub/event-file.ts'
  import { sessionEvent } from './board/event.ts'
  import { libraryEventLogs, matchVideoKey, videoUrl } from './tba/video.ts'
  import { identifyEvents, type ResolvedEvent } from './tba/identify.ts'
  import { newerVersion } from './hub/catalog.ts'
  import { SUMMARY_SHAPE, summaryMapStale, type MatchSummary } from './session/summary.ts'
  import { setPublishNote } from './ui/event-share.svelte.ts'
  import { loadTeam, teamNow } from './ui/team-setting.svelte.ts'
  import { loadTba } from './ui/tba-setting.svelte.ts'
  import { robotChoices } from './ui/robot-list.ts'
  import RobotOptions from './ui/RobotOptions.svelte'
  import { asFile, codeSpec, freshFiles, libraryLinks, libraryLogs, sessionNames as libraryNames, type LibraryLink } from './hub/session-files.ts'
  import ReviewReport from './ui/ReviewReport.svelte'
  import { buildCard } from './report/card.ts'
  import { cardToPngDataUrl, saveForSlack } from './report/card-png.ts'
  import { playedAt, reviewCard, reviewModel } from './report/review-model.ts'
  import { downloadText } from './ui/download.ts'
  import { VERSION } from './version.ts'
  import { deviceId } from './triage/device-id.ts'
  import { scopeOf } from './board/model.ts'
  import { robotIdOf, matchRobot } from './session/summary.ts'
  import { readRole, writeRole } from './board/role.ts'
  import { boardLines, type Change } from './board/writes.ts'
  import type { BoardRole } from './triage/history.ts'
  import type { ExportBoard } from './report/board-export.ts'
  import { boardKey, boardState, HISTORY_FILE_NAME, mergeHistory, migrationLines, parseHistory, serializeHistory, triage, type HistoryEvent, type IssueStatus, type PitCheckEvent } from './triage/history.ts'
  import { howSure, matchRef, realHere, trackRecord, withMarks, wrongHere, type Fire } from './triage/track-record.ts'
  import type { Finding } from './rules/types.ts'
  import { PROFILES, profileId } from './profiles/index.ts'
  import { namesRobot, robotName } from './profiles/choose.ts'
  import { chooseRobot, chosenRobot, HOW_WORDS } from './ui/robot-choice.ts'
  import ProfileBuilder from './ui/ProfileBuilder.svelte'
  import { profilesNow } from './ui/kept-profiles.svelte.ts'
  import CodeFolderControl from './ui/CodeFolderControl.svelte'
  import ModeLine from './ui/ModeLine.svelte'
  import { SHORT_RUN_SECONDS } from './match/match.ts'
  import { chooseMode, sessionNames } from './ui/session-names.svelte.ts'
  import { logModeLine, loneLogMode, modeOf } from './session/mode.ts'
  import { codeFolder } from './ui/code-folder.svelte.ts'

  // Every file dropped so far, so a .dslog dropped after its .wpilog still finds its match. "Clear" empties it.
  let inputs: InputFile[] = []
  let analyses = $state<Analysis[]>([])
  let problems = $state<string[]>([])
  let selected = $state(0)
  let tab = $state<'match' | 'power' | 'devices' | 'limits' | 'logging'>('match')
  // Now (what to do at this moment: the screen the app opens on, ADR 10); review match logs, a whole session of them, the
  // limits wizard, or a robot snapshot (device settings and faults).
  let mode = $state<'now' | 'review' | 'session' | 'wizard' | 'snapshot' | 'profile' | 'foresight' | 'library' | 'powermap'>('now')
  // Whether today is an event day by the outside signals (The Blue Alliance, the library), and the clock: read once, shared by Now and Foresight.
  const todaySig = todaySignal()
  // Robot profiles kept in this browser (built in the Robot profile mode), offered beside the built-in ones.
  const stored = $derived(profilesNow())

  // From the Session view: open one match's log (every piece, if the robot program restarted during it) in Match review.
  async function openFromSession(files: File[]) {
    mode = 'review'
    tab = 'match'
    await load(files)
  }
  // The Library is part of the desktop app (src/hub/): the page opened from disk has no library, so no tab for it.
  // The daily places, in the order Now's "What Hindsight does" lines use. The three expert tools sit behind one labelled menu.
  // The phone (read only, src/hub/browser-hub.ts) has no Robot check (it needs ws:// to the robot) and no tools.
  const phoneHub = phone()
  const readOnly = !!phoneHub
  const MODES = [
    { id: 'now', label: 'Now' } as const,
    { id: 'review', label: 'Match review' }, { id: 'session', label: 'Session' },
    ...(readOnly ? [] : [{ id: 'foresight', label: 'Robot check' } as const]),
    ...(hub() || readOnly ? [{ id: 'library', label: 'Library' } as const] : []),
  ] as const
  const TOOLS = [
    { id: 'wizard', label: 'Limits wizard', hint: 'measure a supply current limit with the robot' },
    { id: 'snapshot', label: 'Robot snapshot', hint: 'read a snapshot.json from the robot' },
    { id: 'profile', label: 'Robot profile', hint: 'draft a robot profile from logs' },
    { id: 'powermap', label: 'Power map', hint: 'which breaker is in each PDP slot, and what it feeds' },
  ] as const
  const activeTool = $derived(TOOLS.find((t) => t.id === mode))
  if (hub()) document.getElementById('app')?.classList.add('wide')
  if (readOnly) document.getElementById('app')?.classList.add('phone')
  void loadTeam()
  void loadTba()
  let sessionView = $state<{ addFiles(files: File[], opts?: { select?: boolean }): Promise<void>; showSummaries(list: MatchSummary[], olderRead?: Record<string, { version: string; at: number }>): void }>()
  // Session summaries restored without their file read the library's copy (desktop app only).
  const findInLibrary = hub() ? (names: string[]) => libraryLogs(hub()!, names) : undefined
  const freshFromLibrary = hub() ? (files: File[]) => freshFiles(hub()!, files) : undefined
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
  // Now's buttons. Today's logs in the library go into the Session view (it does not watch the library: it reads what it is given).
  let loadingToday: Promise<void> | null = null
  /** Today's library logs into the Session view. `select` false (the library grew on its own): the session on screen stays; true (the board button): today's is shown. */
  function loadToday(select = false): Promise<void> {
    // One load at a time: a pull's own call and the library-changed call (NowView) land together.
    return (loadingToday ??= (async () => {
      const app = hub()
      if (!app) return
      const day = dateText(Date.now())
      const { entries } = await app.library()
      const mine = entries.filter((e) => e.local && !e.record.stub && e.record.playedAt !== null && dateText(e.record.playedAt) === day)
      if (mine.length) await sessionView?.addFiles(libraryNames(mine).map((n) => asFile(n, app)), { select })
    })().finally(() => { loadingToday = null }))
  }
  /** A practice day's "Event board not opened yet": the newest event's logs (on-field logs and what was played in the 4 days before them), shown in the Session view. */
  async function loadLatestEvent(): Promise<void> {
    const files = await latestEventFiles()
    if (files.length) await sessionView?.addFiles(files)
  }
  /**
   * The newest event's logs on this laptop: on-field logs and what was played in the 4 days before them; `eventDays`: only
   * what was played on a day the event had on-field logs (its matches and pit runs), not the practice days before it.
   */
  async function latestEventFiles(eventDays = false): Promise<File[]> {
    const app = hub()
    if (!app) return []
    const { entries } = await app.library()
    const mine = entries.filter((e) => e.local && !e.record.stub && e.record.playedAt !== null)
    const field = mine.filter((e) => e.record.onField)
    if (!field.length) return []
    const newest = field.reduce((a, b) => (b.record.playedAt! > a.record.playedAt! ? b : a))
    const last = newest.record.playedAt!
    const same = mine.filter((e) => e.record.playedAt! <= last && e.record.playedAt! > last - 4 * 86400e3 && (!e.record.onField || !newest.record.event || e.record.event === newest.record.event))
    const days = new Set(same.filter((e) => e.record.onField).map((e) => dateText(e.record.playedAt!)))
    return libraryNames(eventDays ? same.filter((e) => days.has(dateText(e.record.playedAt!))) : same).map((n) => asFile(n, app))
  }
  async function showBoard(which: 'today' | 'latest' = 'today') {
    if (which === 'latest') await loadLatestEvent(); else await loadToday(true)
    mode = 'session'
  }
  const goPlace = (place: Place) => { mode = place }
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
  // What's new after an update is shown only on a computer that has logs (a fresh install has nothing to compare with).
  const hasLogs = $derived((hub() ? todaySig.libraryLogs.some((r) => !r.stub) : false) || sessions.length > 0 || analyses.length > 0)
  /** The session whose matches hold this log (as a match or one of its pieces), pit runs not counted. */
  const sessionHolding = (name: string) => sessions.find((s) => s.matches.some((m) => m.fileName === name || m.pieces?.includes(name)))
  const standing = $derived.by(() => {
    if (!current) return new Set<string>()
    const name = current.match.fileName
    const own = sessionHolding(name)
    return own ? standingKeys(own) : new Set<string>()
  })

  // The mode line of the open log (ADR 3): its session's, a pit run said so; a log no session holds is worded from the log alone.
  const modeNow = $derived.by(() => {
    if (!current) return null
    const name = current.match.fileName
    const own = sessions.find((s) => [...s.matches, ...(s.pitRuns ?? [])].some((m) => m.fileName === name || m.pieces?.includes(name)))
    if (own) return { text: logModeLine(own, name), mode: modeOf(own), byHand: !!own.modeByHand, id: own.id }
    const lone = loneLogMode({ onField: current.match.fms, event: current.match.event, matchLabel: current.match.matchLabel, playedAt: playedAt(current) }, sessionNames())
    return { text: lone.line, mode: lone.mode, byHand: lone.byHand, id: lone.sessionId }
  })

  // Known issues: kept in this browser between visits, and saved to / loaded from hindsight-history.jsonl.
  const STORE = 'hindsight.history'
  // In the desktop app the history is the library's: history/<machine id>.jsonl, merged with the teammates' files by sync.
  // The browser store is then read only once, to move what it holds into the library.
  const library = hub()
  let history = $state<HistoryEvent[]>(library || readOnly ? [] : readStoredHistory())
  let unsaved = $state(false)
  let historyNote = $state('')
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
  // Lines to the library's file go one after another, so two quick marks reach the file in the order they were made.
  // Events whose append failed: shown anyway, and retried on the next open from the browser store.
  let unwritten: HistoryEvent[] = []
  let appending: Promise<unknown> = Promise.resolve()
  function appendToLibrary(lines: string) {
    appending = appending.then(() => library!.appendHistory(lines)).catch((e: Error) => {
      // Keep the marks: the browser store holds them, and the next open moves them into the library (migrationLines).
      unwritten = mergeHistory(unwritten, parseHistory(lines).events)
      try { localStorage.setItem(STORE, `${localStorage.getItem(STORE) ?? ''}${lines}`) } catch { /* no browser store either */ }
      historyNote = `The history could not be written to the library, so it is kept in this browser and retried on the next open: ${e.message}`
    })
  }
  async function openLibraryHistory() {
    if (!library) return
    try {
      const inLibrary = await library.history()
      const stored = migrationLines(inLibrary, localStorage.getItem(STORE) ?? '')
      if (stored) {
        await library.appendHistory(stored.text)
        historyNote = `Moved ${stored.count} line${stored.count === 1 ? '' : 's'} of known-issue history from this browser into the library.`
      }
      await refreshLibraryHistory()
    } catch (e) { historyNote = `The history could not be read from the library: ${e instanceof Error ? e.message : String(e)}` }
  }
  appending = appending.then(openLibraryHistory)
  // Sync (in the Library) may have brought teammates' lines down: read the library's history again when the view changes.
  $effect(() => { void mode; if (library) appending = appending.then(refreshLibraryHistory) })
  let generation = 0
  async function refreshLibraryHistory() {
    const was = generation
    try { const read = parseHistory(await library!.history()).events; if (was === generation) history = mergeHistory(read, unwritten) } catch { /* the note from the last read stands */ }
  }
  function keep(events: HistoryEvent[], changed: boolean) {
    if (library) generation++
    const kept = keepHistory(history, events, {
      readOnly,
      ...(library ? { append: appendToLibrary } : { store: (text: string) => { try { localStorage.setItem(STORE, text) } catch { /* private window: the file is the only copy */ } } }),
    })
    history = kept.history
    if (kept.wrote && changed && !library) unsaved = true
  }
  function mark(finding: Finding, status: IssueStatus, note: string) {
    const at = here ? { match: here.id, ...(here.event ? { event: here.event } : {}), ...(here.played !== null ? { played: new Date(here.played).toISOString() } : {}) } : {}
    keep([...history, { type: 'issue', key: finding.key, status, note, when: new Date().toISOString(), ...at }], true)
  }
  // The issue board's changes: board lines and event notes, stamped with this device's id (the hub's machine id, else a random one kept on this page).
  async function writeBoard(build: (device: string, history: HistoryEvent[]) => HistoryEvent[]) {
    let device: string
    try { device = library ? (await library.info()).machineId : deviceId(localStorage) } catch {
      // The hub did not answer (or this is the page): this page's own id, and if storage is blocked, one for this visit.
      try { device = deviceId(localStorage) } catch { device = deviceId({ getItem: () => null, setItem: () => { throw new Error('none') } }) }
    }
    keep([...history, ...build(device, history)], true)
  }
  // The power map (src/power/power-map.ts): the screen, the strips and the finding thumbnails share the history and the writer.
  // When the team's history changes the robot's map for an open log, only the two breaker rules run again on it (no re-parse).
  $effect(() => { setMapHistory(history) })
  setMapWriter(writeBoard, () => role, () => { mode = 'powermap' })
  $effect(() => {
    const next = withPowerMaps(untrack(() => analyses), history)
    if (next) analyses = next
  })

  // Teammates' marks were brought down (the 2-min pull, or a Sync): read the history again, and pull now when the window comes back.
  $effect(() => {
    if (!library) return
    const stop = library.onHistoryChanged(() => { appending = appending.then(refreshLibraryHistory) })
    const onVisible = () => { if (document.visibilityState === 'visible') void library.shareNow().catch(() => {}) }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisible) }
  })

  // ---- The laptop publishes the latest event's summaries for the phone (src/hub/event-publish.ts) ----
  // The Session view's own summaries and grouping (so the phone's board is built from what this board is built from), a
  // few seconds after they last changed: an add, a read again or a restore is one append. The main process pushes the file.
  let summaries = $state.raw<MatchSummary[]>([])
  // Every log of the latest event needs a summary read by this Hindsight: after an update the saved ones are too old to reuse,
  // and a day-one log may never have been opened. So once the library is read, and whenever it grows, its latest event's logs go
  // through the Session view (which reads only those it has no current summary for) without changing what it shows.
  let eventHanded = ''
  $effect(() => {
    if (!library || !todaySig.libraryLoaded) return
    void todaySig.libraryLogs
    void (async () => {
      const files = await latestEventFiles(true)
      const handed = files.map((f) => `${f.name}|${f.size}`).sort().join('\n')
      if (!files.length || handed === eventHanded) return
      eventHanded = handed
      await sessionView?.addFiles(files, { select: false })
    })().catch(() => {})
  })
  $effect(() => {
    if (!library) return
    void sessions; void summaries; void tbaTeam(); void tbaGetter(); void todaySig.libraryLogs
    const t = setTimeout(() => { publishing = publishing.then(publishEvent) }, 3_000)
    return () => clearTimeout(t)
  })
  // Every other event in the library, published once (src/hub/event-backfill.ts): a minute after the library is first read
  // (or once a team number and The Blue Alliance key are set), so start-up isn't slowed; events this laptop has already
  // published are skipped without reading a byte. The latest event is left to publishEvent (it has the code folder).
  let backfillStarted = false
  $effect(() => {
    void tbaTeam(); void tbaGetter()
    if (!library || !todaySig.libraryLoaded || backfillStarted || !tbaGetter() || tbaTeam() === null) return
    backfillStarted = true
    const t = setTimeout(() => { publishing = publishing.then(backfillPublish) }, 60_000)
    return () => { clearTimeout(t); backfillStarted = false }
  })
  /** Wait until the page is idle, then a moment more: the pass reads logs on the page's own thread. */
  const idle = () => new Promise<void>((r) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
    if (ric) ric(() => setTimeout(r, 500), { timeout: 5_000 }); else setTimeout(r, 500)
  })
  async function backfillPublish() {
    const app = hub()
    const [get, team] = [tbaGetter(), tbaTeam()]
    if (!app || !get || team === null) return
    try {
      const { entries } = await app.library()
      const named = new Map(libraryNames(entries).map((n) => [n.entry, n]))
      // The latest event's logs count as done here: publishEvent publishes them, with the code folder.
      const latest = new Set((await latestEventFiles(true)).map((f) => f.name))
      const latestShas = libraryNames(entries).filter((n) => latest.has(n.name)).map((n) => n.entry.record.sha256)
      const done = await backfillEvents({
        entries, published: new Set([...(await app.publishedLogs()), ...latestShas]),
        skipped: new Set(readSkipped(localStorage, SUMMARY_SHAPE)), markSkipped: async (shas) => { writeSkipped(localStorage, SUMMARY_SHAPE, [...readSkipped(localStorage, SUMMARY_SHAPE), ...shas]) },
        read: async (e) => {
          const f = asFile(named.get(e)!, app)
          const [bytes, beside] = await Promise.all([f.arrayBuffer().then((b) => new Uint8Array(b)), readBeside(f, [])])
          await idle()
          return summarizeLogWithCode({ name: f.name, bytes }, null, null, chosenRobot(f.name), [...PROFILES, ...stored], history, beside)
        },
        place: async (s) => { const found = await sessionEvent(s, team, get); return { key: found.event?.key ?? null, retry: !!found.retry } },
        append: async (key, lines) => { await app.appendEvent(key, lines.map(serializeEventLine).join('')) },
        version: VERSION, analyzerHash: ANALYZER_HASH, now: Date.now,
      })
      if (done.read) console.log(`Hindsight: published ${done.events} earlier event${done.events === 1 ? '' : 's'} for the phone (${done.read} logs read)`)
    } catch (e) { console.warn('Hindsight: publishing earlier events for the phone stopped:', e) }
  }
  // One publish at a time: a run waiting on The Blue Alliance must not overlap the next (both would pass the same dedupe).
  let publishing: Promise<void> = Promise.resolve()
  async function publishEvent() {
    const app = hub()
    const s = latestEventSession(sessions)
    if (!app || !s) { setPublishNote(null); return }
    const [get, team] = [tbaGetter(), tbaTeam()]
    if (!get || team === null) { setPublishNote(`No event known for ${s.label}'s logs: add your team number and a The Blue Alliance read key under This laptop…, so the phone can show this event.`); return }
    try {
      const found = await sessionEvent(s, team, get)
      if (!found.event) { setPublishNote(`${s.label} is not published for the phone: ${found.why}.`); return }
      // The library's records as last read (todaySig reads them again when a job ends), not a fresh snapshot that stats every file.
      const shas = new Map(todaySig.libraryLogs.flatMap((r) => r.names.map((n) => [n, r.sha256] as const)))
      const lines = eventLines({ summaries, names: eventLogNames(s), shaOf: (n) => shas.get(n) ?? null, version: VERSION, analyzerHash: ANALYZER_HASH, at: Date.now() })
      if (lines.length) await app.appendEvent(found.event.key, lines.map(serializeEventLine).join(''))
      setPublishNote(null)
    } catch (e) { setPublishNote(`The phone's copy of ${s.label} could not be written: ${e instanceof Error ? e.message : String(e)}`) }
  }

  // ---- The phone: one event's summaries and every laptop's marks, read from the team's Drive, never written ----
  let phoneKey = $state<string | null>(null)
  /** The events laptops have published, newest push first, and the one picked on this phone (src/phone/event-choice.ts). */
  let phoneEvents = $state.raw<string[]>([])
  let picked = $state<string | null>(readOnly ? pickedEvent(localStorage) : null)
  function choosePhoneEvent(key: string) { picked = key; pickEvent(localStorage, key) }
  let phoneEventInfo = $state.raw<Map<string, EventInfo>>(new Map())
  /** Names and start dates from The Blue Alliance (the team's events of each year, one cached request a year); none offline. */
  async function eventInfo(keys: string[]): Promise<Map<string, EventInfo>> {
    const [get, team] = [tbaGetter(), tbaTeam()]
    const out = new Map<string, EventInfo>()
    if (!get || team === null) return out
    for (const year of new Set(keys.map((k) => Number(k.slice(0, 4))))) {
      try { for (const e of (await teamEvents(get, team, year)).data) out.set(e.key, { name: e.name, start: e.start_date }) } catch { /* that year unnamed */ }
    }
    return out
  }
  let phoneNote = $state('')
  let phoneFrom = $state.raw<Map<string, { laptop: string; olderRead: string | null }>>(new Map())
  let reviewing = $state.raw<MatchSummary | null>(null)
  let phoneLoading: Promise<void> | null = null
  let phoneAgain = false
  /** Read the event and the marks again; a change that lands mid-read gets one more read after it, not a minute's wait. */
  function loadPhone(): Promise<void> {
    if (phoneLoading) { phoneAgain = true; return phoneLoading }
    return (phoneLoading = (async () => {
      if (!phoneHub) return
      try {
        history = parseHistory(await phoneHub.history()).events
        const keys = (await phoneHub.eventKeys()).map((e) => e.key)
        phoneEventInfo = await eventInfo(keys)
        phoneEvents = orderEvents(keys, phoneEventInfo)
        const key = phoneEvent(todaySig.external?.key ?? null, picked, phoneEvents)
        phoneKey = key
        if (!key) { phoneNote = 'No laptop has published an event to the team Drive yet.'; return }
        const ev = await phoneHub.event(key)
        const drawable = ev.logs.filter((l) => l.line.shape === SUMMARY_SHAPE)
        // Read by an older Hindsight whose analyzer differs from this page's (every release has a new version; only a changed
        // analyzer reads a log differently): the version that read it.
        const older = ({ analyzer, summary }: (typeof drawable)[number]['line']) => newerVersion(VERSION, analyzer) && analyzerHashOf(analyzer) !== analyzerHashOf(analyzerId(VERSION, ANALYZER_HASH, summary.robot.profileId, !!summary.codeFolder, summary.powerMap?.stamp)) ? /^\d+(\.\d+)*/.exec(analyzer)?.[0] ?? null : null
        phoneFrom = new Map(drawable.map((l) => [l.line.summary.fileName, { laptop: l.machine, olderRead: older(l.line) }]))
        sessionView?.showSummaries(drawable.map((l) => l.line.summary), Object.fromEntries(drawable.flatMap((l) => { const v = older(l.line); return v ? [[l.line.summary.fileName, { version: v, at: l.line.at }]] : [] })))
        const hidden = ev.logs.length - drawable.length
        phoneNote = ev.logs.length === 0 ? `No laptop has shared ${key}'s matches yet: they show here once a laptop signed in to the team Drive adds a log.`
          : hidden ? `${hidden} match${hidden === 1 ? ' was' : 'es were'} read by a Hindsight this phone can't draw: update the page.` : ''
      } catch (e) { phoneNote = `Could not read the team Drive (${e instanceof Error ? e.message : String(e)}): showing the last copy.` }
    })().finally(() => { phoneLoading = null; if (phoneAgain) { phoneAgain = false; void loadPhone() } }))
  }
  $effect(() => {
    if (!phoneHub) return
    void todaySig.external?.key
    void picked
    void loadPhone()
  })
  $effect(() => {
    if (!phoneHub || !phoneKey) return
    const off = phoneHub.onChange(() => void loadPhone())
    const stop = phoneHub.watch(phoneKey)
    // The "checked" time moves with each minute's check, changed or not.
    const tick = setInterval(() => { freshTick++ }, 30_000)
    return () => { off(); stop(); clearInterval(tick) }
  })
  let freshTick = $state(0)
  const fresh = $derived.by(() => {
    void history; void sessions; void freshTick
    const f = phoneHub?.freshness()
    const t = (ms: number | null) => (ms === null ? null : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    return f ? { read: t(f.readAt), pushed: t(f.newestFile) } : null
  })
  // The phone's Library reads the laptops' lists only once it is first opened, then stays mounted (a download keeps its Stop).
  let libraryOpened = $state(false)
  $effect(() => { if (mode === 'library') libraryOpened = true })
  // A summary from the board or Session: it takes the place of a log opened from the phone's Library.
  function openSummary(m: MatchSummary) { if (readOnly) clearAll(); reviewing = m; mode = 'review' }

  function saveHistory() {
    downloadText(HISTORY_FILE_NAME, serializeHistory(history), 'application/x-ndjson')
    unsaved = false
  }

  // Where each loaded log lives, by file name, so the match head can hand it to AdvantageScope. Not reactive: it is read only when `current` is.
  const fileLocations = new Map<string, { library: string } | { file: string }>()
  function rememberLocation(f: File) {
    if (f instanceof LibraryFile) { fileLocations.set(f.name, { library: f.libraryPath }); return }
    const path = hub()?.pathForFile(f)
    if (path) fileLocations.set(f.name, { file: path })
  }
  // The open match's video on The Blue Alliance, when it has one: the session's event (the one the board uses) and the log's own match
  // (src/tba/video.ts). Nothing shows while it is being found, or when anything is missing. The lookup is keyed on primitives, so a
  // `sessions` reassignment or a replaced analysis of the same log neither re-asks nor blanks the link.
  let videoKey = $state<string | null>(null)
  const videoName = $derived(current?.match.fileName)
  const videoLabel = $derived(current?.match.fms ? current.match.matchLabel : '')
  const videoAuto = $derived(current && current.match.epochOffset !== null && current.match.matchStart !== null ? current.match.epochOffset + current.match.matchStart : null)
  // Where the event comes from: the loaded session that holds the log, else (opened from the Library) its library record's neighbours.
  const videoSource = $derived.by(() => {
    if (!videoName || !videoLabel) return undefined
    const held = sessionHolding(videoName)
    return held ? `session:${held.id}` : (() => { const l = libraryEventLogs(todaySig.libraryLogs, videoName); return l ? `library:${l.sha}` : undefined })()
  })
  const videoHasGetter = $derived(tbaGetter() !== null)
  $effect(() => { void videoName; videoKey = null })
  $effect(() => {
    const [name, label, auto, sid, team] = [videoName, videoLabel, videoAuto, videoSource, tbaTeam()]
    const get = tbaGetter()
    if (!name || !sid || !videoHasGetter || !get || team === null) return
    const own = untrack(() => sessionHolding(name))
    const lib = own ? null : untrack(() => libraryEventLogs(todaySig.libraryLogs, name))
    if (!own && !lib) return
    let stale = false
    void (async () => {
      let event: ResolvedEvent | null = null
      if (own) event = (await sessionEvent(own, team, get).catch(() => null))?.event ?? null
      else if (lib) event = (await identifyEvents(lib.logs, team, get).catch(() => null))?.byFile.get(lib.sha) ?? null
      if (!event || event.by === 'date' || stale) return
      const key = await matchVideoKey(get, team, event.key, event.end, label, auto)
      if (!stale) videoKey = key
    })()
    return () => { stale = true }
  })
  const ascopeTarget = $derived(current ? fileLocations.get(current.match.fileName) : undefined)
  // The Devices tab reads a log's .hoot files through the desktop app, so it shows for library logs there (ADR 13).
  const devicesPath = $derived(!readOnly && hub() && ascopeTarget && 'library' in ascopeTarget ? ascopeTarget.library : null)
  $effect(() => { if (tab === 'devices' && !devicesPath) tab = 'match' })
  // .hoot readings by robot-log file name (desktop app, library logs only). Every analysis pass builds new Matches, so
  // the readings are attached again whenever the list changes (src/hoot/attach.ts, ADR 14). Only the experimental tier reads them.
  let hootReadings = $state<Map<string, HootReading[]>>(new Map())
  const attachedFiles = (a: Analysis) => (a.match.hoot ?? []).map((h) => h.reading.file).join('|')
  $effect(() => {
    const readings = hootReadings
    let changed = false
    const next = analyses.map((a) => {
      const r = readings.get(a.match.fileName)
      if (!r || a.report.noRules || attachedFiles(a) === r.map((x) => x.file).join('|')) return a
      changed = true
      return { ...a, report: attachHoot(a.match, a.report, r) }
    })
    if (changed) analyses = next
  })
  const keepReadings = (fileName: string, readings: HootReading[]) => { hootReadings = new Map(hootReadings).set(fileName, readings) }
  // The open log's name: a primitive, so replacing `analyses` (an attach, a power-map rerun) doesn't fetch the cache again.
  const openName = $derived(current?.match.fileName)
  // The open library log's .hoot as this computer holds it: readings already cached are attached at once (no owlet run, no job).
  let hootHere = $state<HootCached | undefined>(undefined)
  // Bumped when the Devices tab has read a .hoot: the cache then answers what is still unread.
  let hootTick = $state(0)
  $effect(() => {
    void hootTick
    const path = devicesPath
    const name = openName
    hootHere = undefined
    if (!path || !name || /\.hoot$/i.test(path)) return
    let stale = false
    void hub()!.hootCached(path).then((c) => {
      if (stale) return
      hootHere = c
      if (c.readings.length) keepReadings(name, c.readings)
    }).catch(() => {})
    return () => { stale = true }
  })
  let ascopeBusy = $state(false)
  let ascopeError = $state('')
  $effect(() => { current?.match.fileName; ascopeError = '' })
  async function openInAdvantageScope() {
    if (!ascopeTarget) return
    ascopeBusy = true
    ascopeError = ''
    try { await hub()!.openInAdvantageScope(ascopeTarget) } catch (e) { ascopeError = e instanceof Error ? e.message : String(e) } finally { ascopeBusy = false }
  }

  async function load(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    files.forEach(rememberLocation)
    busy = true
    const pass = ++passes
    await new Promise((r) => setTimeout(r, 30)) // let "Reading…" paint
    try {
      const started = performance.now()
      // A library log brings its Driver Station files with it.
      const unread: string[] = []
      const added: InputFile[] = (await Promise.all(files.map(async (f) => [{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, ...(await readBeside(f, unread))]))).flat()
      await analyzeAdded(added, files.length, started, pass, unread)
    } catch (error) {
      problems = [String(error)]
    } finally {
      if (pass === passes) busy = false
    }
  }

  /** The phone's Library opened a log: its bytes as downloaded (never copied into a File), and only that log held. */
  async function openFromPhone(files: OpenedFile[]) {
    mode = 'review'
    tab = 'match'
    reviewing = null
    inputs = []
    busy = true
    const pass = ++passes
    await new Promise((r) => setTimeout(r, 30)) // let "Reading…" paint
    try { await analyzeAdded(files, files.length, performance.now(), pass) } catch (error) { problems = [String(error)] } finally { if (pass === passes) busy = false }
  }

  /** Read the added files with those already open; the newest becomes the shown match. */
  async function analyzeAdded(added: InputFile[], count: number, started: number, pass: number, unread: string[] = []) {
    // The same file dropped twice replaces the first copy.
    const sameFile = (a: InputFile, b: InputFile) => a.name === b.name && a.bytes.length === b.bytes.length
    inputs = [...inputs.filter((old) => !added.some((n) => sameFile(old, n))), ...added]
    const read = performance.now()
    const result = await analyzeFilesWithCode(inputs, codeFolder.current, chosenRobot, [...PROFILES, ...stored], history)
    if (result.history.length) keep(mergeHistory(history, result.history), false)
    if (pass !== passes) return // a later pass (another code folder, another robot) has the newer answer
    const done = performance.now()
    analyses = result.analyses
    problems = [...unread, ...result.problems]
    const newest = result.analyses.findIndex((a) => added.some((f) => f.name === a.match.fileName))
    selected = Math.max(0, newest)
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    lastLoad = { files: count, readMs: read - started, analyzeMs: done - read, heapMB: mem ? mem.usedJSHeapSize / 2 ** 20 : null }
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
      const result = await analyzeFilesWithCode(inputs, codeFolder.current, chosenRobot, [...PROFILES, ...stored], history)
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
    passes++ // a read still running for what is cleared lands nowhere
    busy = false
    fileLocations.clear()
    inputs = []
    analyses = []
    hootReadings = new Map()
    problems = []
    lastLoad = null
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    // In the wizard, logs go to a step's own "Check it" box, not to Match review. Dropped on Now they open in Match review.
    if (mode === 'now' && e.dataTransfer?.files.length) { mode = 'review'; tab = 'match' } else if (mode !== 'review') return
    if (e.dataTransfer?.files) load(e.dataTransfer.files)
  }

  // What the team recorded on the board for this log's issues (priority, notes, cause states), filed under the robot as the board files it.
  // The export is scoped like the board: by the session that holds this log (its event and match span), so a deferral made
  // after a later match of the same event still counts on a log with no event name; a log in no session falls back to itself.
  const boardFor = (a: Analysis): ExportBoard => {
    const r = refOf(a)
    const held = sessions.find((s) => s.kind === 'event' && [...s.matches, ...(s.pitRuns ?? [])].some((m) => m.fileName === a.match.fileName || m.pieces?.includes(a.match.fileName)))
    return { states: boardState(history), robot: robotIdOf(matchRobot(a.match)), scope: held ? scopeOf(held) : { event: r.event, from: r.played, to: r.played } }
  }
  async function downloadForClaude() {
    if (!current || !shownCurrent) return
    // Lists what is inside first (ADR 5); the file is saved only on Save.
    await saveForClaude(findingsFileName(current.match), buildFindingsJson(shownCurrent.match, shownCurrent.report, issues, wrongNow, realNow, boardFor(shownCurrent)))
  }

  // The debug workspace in Match review (ADR 3): cause states are board lines under this log's robot, written with this laptop's role.
  const store = (): Storage | null => { try { return localStorage } catch { return null } }
  let role = $state<BoardRole | null>((() => { const s = store(); return s ? readRole(s) : null })())
  const debug = $derived(current ? {
    role,
    setRole: (r: BoardRole) => { role = r; const s = store(); if (s) writeRole(s, r) },
    marks: (f: Finding) => boardState(history).get(boardKey(f.key, robotIdOf(matchRobot(current!.match))))?.causes,
    write: (f: Finding, changes: Change[]) => {
      const r = role
      if (!r) return
      const robot = robotIdOf(matchRobot(current!.match))
      const at = here ? { match: here.id, ...(here.event ? { event: here.event } : {}), ...(here.played !== null ? { played: new Date(here.played).toISOString() } : {}) } : {}
      writeBoard((device, h) => boardLines(h, { device, role: r }, new Date(), { key: f.key, robot }, changes, at))
    },
  } : undefined)

  // "Save for Slack": the browser's print dialog (Save as PDF; the title names the file), then the phone card as a PNG.
  const reviewCardOf = (a: Analysis) => buildCard(reviewCard(reviewModel(marked(a), issues, standing, wrongHere(refOf(a), marks))))
  let saveProblem = $state<string | null>(null)
  async function saveForSlackReview() {
    saveProblem = null
    if (!current) return
    const base = current.match.fileName.replace(/\.(wpilog|hoot)$/i, '')
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
    findingsJson: () => (shownCurrent ? JSON.stringify(buildFindingsJson(shownCurrent.match, shownCurrent.report, issues, wrongNow, realNow, boardFor(shownCurrent)), null, 1) : null),
    findingsFile: () => (current ? findingsFileName(current.match) : null),
    reviewCard: () => (current ? reviewCardOf(current) : null),
    reviewCardPng: async () => (current ? await cardToPngDataUrl(reviewCardOf(current)) : null),
    foresightCardPng: async () => { const c = (window as unknown as { hindsight: { foresightCard?: () => Parameters<typeof cardToPngDataUrl>[0] } }).hindsight.foresightCard?.(); return c ? await cardToPngDataUrl(c) : null },
    get timings() {
      return { lastLoad, matches: analyses.map((a) => ({ file: a.match.fileName, ...a.timing, findings: a.report.findings.length })) }
    },
  }

  // Off the field there is no match: the log holds runs (ADR 8), each judged.
  const fmtDuration = (a: Analysis) => {
    if (a.match.matchStart === null || a.match.matchEnd === null) return 'never enabled'
    if (a.match.fms) return `${(a.match.matchEnd - a.match.matchStart).toFixed(0)} s match`
    const runs = a.match.runs
    return `${runs.length} run${runs.length === 1 ? '' : 's'}, ${runs.reduce((n, r) => n + r.end - r.start, 0).toFixed(0)} s enabled`
  }
</script>

<svelte:window ondragover={(e) => { e.preventDefault(); dragging = mode === 'review' }} ondragleave={(e) => { if (e.relatedTarget === null) dragging = false }} ondrop={onDrop} />

<div class="top" class:compact={mode === 'review' && !!current}>
<header class:screen-only={reportable}>
  <h1>Hindsight</h1>
  {#if readOnly}<p class="tag">What the team's laptops found and marked at this event, and any team log from the Library.</p>{:else if !(mode === 'review' && current) && !(mode === 'session' && sessionShown)}<p class="tag">Reads your robot's logs and code, says what went wrong and who should act, and checks the robot before each match.{' '}{#if hub()}Your logs and triage notes leave this computer only for your team's Drive folder, once you sign in.{:else}Your logs never leave this computer.{/if}</p>{/if}
</header>

<nav class="modes" class:screen-only={reportable} aria-label="Mode">
  {#each MODES as m (m.id)}<button class:active={mode === m.id} data-label={m.label} aria-current={mode === m.id ? 'page' : undefined} onclick={() => (mode = m.id)}>{m.label}</button>{/each}
  {#if !readOnly}<Menu label={activeTool ? `Tools: ${activeTool.label}` : 'Tools'} current={!!activeTool} tab items={TOOLS.map((t) => ({ id: t.id, label: t.label, hint: t.hint, onselect: () => (t.id === 'powermap' ? openPowerMap() : (mode = t.id)) }))} />{/if}
  {#if hub() && !readOnly}<UpdateChip {hasLogs} />{/if}
</nav>
{#if readOnly}
  <p class="phone-line screen-only" role="status" data-phone-fresh>{#if !todaySig.external?.key && phoneEvents.length > 1}<label>Event <select value={phoneKey} onchange={(e) => choosePhoneEvent((e.currentTarget as HTMLSelectElement).value)}>{#each phoneEvents as k (k)}<option value={k}>{eventLabel(k, phoneEventInfo)}</option>{/each}</select></label>{:else}{phoneKey ? eventLabel(phoneKey, phoneEventInfo) : 'No event yet'}{/if}{fresh?.read ? ` · checked ${fresh.read}` : ''}{fresh?.pushed ? ` · a laptop last shared at ${fresh.pushed}` : ''}</p>
  {#if phoneNote}<p class="phone-line warn" role="status">{phoneNote}</p>{/if}
{/if}
</div>

<!-- All the views stay mounted and only the active one shows, so switching never loses a loaded session,
     the matches in review, the wizard's progress, or a snapshot. -->
{#if !readOnly}
<div hidden={mode !== 'wizard'} class:screen-only={reportable}><Wizard matches={analyses} /></div>
<div hidden={mode !== 'snapshot'} class:screen-only={reportable}><SnapshotView /></div>
<div hidden={mode !== 'profile'} class:screen-only={reportable}><ProfileBuilder bind:this={profileBuilder} /></div>
<div hidden={mode !== 'powermap'} class:screen-only={reportable}><PowerMap /></div>
{/if}
<div hidden={mode !== 'now'} class:screen-only={reportable}>
  <NowView {sessions} {history} {marks} signal={todaySig} openLogs={analyses.length} onGo={goPlace} onBoard={showBoard} onOpenLog={openFromSession} onOpenLogs={openInSession} onAdded={() => loadToday()} />
</div>
{#if !readOnly}<div hidden={mode !== 'foresight'}>
  <ForesightView signal={todaySig} {history} {sessions} onBoard={writeBoard} onPitCheck={(e: PitCheckEvent) => keep([...history, e], true)} />
  {#if unsaved}<p class="history screen-only">Changes were added to the team's history in this browser · <button class="link" onclick={saveHistory}>Save {HISTORY_FILE_NAME}</button></p>{/if}
</div>{/if}
{#if hub()}<div hidden={mode !== 'library'}><LibraryView onOpenSession={openInSession} onOpenMatch={openFromSession} onDraft={startDraft} onReview={() => (mode = 'review')} /></div>{:else if phoneHub && libraryOpened}<div hidden={mode !== 'library'}><PhoneLibrary hub={phoneHub} onOpening={clearAll} onOpen={openFromPhone} /></div>{/if}
<div hidden={mode !== 'session'}><SessionView bind:this={sessionView} {marks} {history} onBoard={readOnly ? undefined : writeBoard} {readOnly} onOpenSummary={readOnly ? openSummary : undefined} bind:summariesOut={summaries} onOpen={openFromSession} findLogs={findInLibrary} freshen={freshFromLibrary} linksFor={linksInLibrary} onDraft={draftFromCode} bind:hasSession={sessionShown} bind:sessionsOut={sessions} />{#if readOnly}<div class="screen-only phone-setup"><TbaFields /></div>{/if}</div>
<div hidden={mode !== 'review'} class:screen-only={reportable}>
{#if readOnly && !current && !busy && !problems.length}
  {@const ev = latestEventSession(sessions)}
  {@const shownSummary = reviewing ?? ev?.matches.at(-1) ?? null}
  {#if ev}
    <nav class="pick" aria-label="This event's matches">
      {#each [...ev.matches].reverse() as m (m.fileName)}
        {@const errors = Object.values(m.rules).reduce((n, r) => n + r.findings.filter((f) => f.severity === 'error').length, 0)}
        <button type="button" class:active={shownSummary?.fileName === m.fileName} aria-current={shownSummary?.fileName === m.fileName ? 'true' : undefined} onclick={() => openSummary(m)}>{m.matchLabel ? m.matchLabel.replace(/^Qualification /, 'Q') : m.fileName}{#if errors}<small>{errors} error{errors === 1 ? '' : 's'}</small>{/if}</button>
      {/each}
    </nav>
  {:else}<p class="meta">No match summaries yet: a laptop publishes them when it adds a log.</p>{/if}
  {#if shownSummary}
    {@const ref = matchRef(shownSummary, shownSummary.playedAt)}
    <SummaryReview summary={shownSummary} issues={marks.issues} wrong={wrongHere(ref, marks)} real={realHere(ref, marks)} laptop={phoneFrom.get(shownSummary.fileName)?.laptop ?? null} olderRead={phoneFrom.get(shownSummary.fileName)?.olderRead ?? null} mapStale={summaryMapStale(shownSummary, history)} />
  {/if}
{:else}
{#if readOnly && (current || busy || problems.length)}
  <p class="phone-line">Opened from the Library{#if busy}: reading…{/if} · <button class="link" onclick={() => { clearAll(); mode = 'library' }}>Back to the Library</button></p>
{/if}
{#if !readOnly && (!current || dragging)}
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

{#if historyNote}<p class="history screen-only" role="status">{historyNote}</p>{/if}
{#if history.length && !readOnly}
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
      {#if videoKey}<a class="button choose" href={videoUrl(videoKey)} target="_blank" rel="noreferrer" title="Opens the match video on YouTube, from its start">Match video</a>{/if}
      {#if ascopeTarget}
        <button class="button choose" title="Open this log in AdvantageScope" disabled={ascopeBusy} onclick={openInAdvantageScope}>Open in AdvantageScope</button>
      {/if}
      {#if !readOnly}<label class="button choose">
        <input type="file" multiple accept=".wpilog,.dslog,.dsevents,.jsonl" onchange={chosen} />
        Choose logs…
      </label>
      <Menu label="File" align="right" items={[
        { id: 'claude', label: 'Download for Claude', hint: 'findings.json: findings, evidence and short data windows', onselect: downloadForClaude },
        { id: 'slack', label: 'Save for Slack', hint: 'print dialog (choose Save as PDF) and a phone-sized card (PNG)', onselect: saveForSlackReview },
        { id: 'clear', label: 'Clear all', hint: 'forget the loaded logs', onselect: clearAll },
      ]} />{/if}
    </span>
    <div class="rest">
      {#if modeNow && !readOnly}<ModeLine text={modeNow.text} mode={modeNow.mode} byHand={modeNow.byHand} onChange={(m) => chooseMode(modeNow.id, m)} hint="Changes how this session's logs are grouped and counted (matches or logs, pit runs, trends). Each log is judged from its own field data." />{/if}
      <p class="meta">
        <code>{current.match.fileName}</code>{#each current.match.ds as d (d.fileName)}{' + '}<code>{d.fileName}</code>{/each} ·
        {fmtDuration(current)}{#if !current.report.noRules}{' '}· code <code>{current.match.build.sha.slice(0, 7) || '?'}</code> on {current.match.build.branch || '?'}{/if}
        {#if isUncommitted(current.match.build.dirty)}<strong class="dirty">(uncommitted changes)</strong>{/if}
      </p>
      <details class="more">
        <summary>Robot: <strong>{robotName(current.match.profile.name, current.match.profileChoice)}</strong></summary>
        <p class="meta">
          {#if !namesRobot(current.match.profileChoice)}No profile is for this robot ·{:else}{#if hasPin(current.match.profile.code)}Code as of {current.match.profile.code.branch} <code>{current.match.profile.code.sha}</code>{:else}Code not known{/if}
          ({HOW_WORDS[current.match.profileChoice.how]}) ·{/if}
          {#if !readOnly}<label>use <select onchange={(e) => setRobot((e.currentTarget as HTMLSelectElement).value)}>
            <option value="auto" selected={current.match.profileChoice.how !== 'chosen by you'}>automatic</option>
            <RobotOptions groups={robotChoices(PROFILES, stored, teamNow(), namesRobot(current.match.profileChoice) ? [profileId(current.match.profile)] : [])} selectedId={current.match.profileChoice.how === 'chosen by you' ? profileId(current.match.profile) : null} />
          </select></label>{/if}
        </p>
      </details>
      {#if current.report.droppedInShortRuns}<p class="meta" data-short-runs>{current.report.droppedInShortRuns.length} performance finding{current.report.droppedInShortRuns.length === 1 ? ' was' : 's were'} not shown: {current.report.droppedInShortRuns.length === 1 ? 'it fell' : 'they fell'} in a run under {SHORT_RUN_SECONDS} s, too short to show a margin or a rate ({[...new Set(current.report.droppedInShortRuns)].join(', ')}). Faults are always shown.</p>{/if}
      {#if current.match.profileChoice.note}<p class="meta dirty">{current.match.profileChoice.note}</p>{/if}
    </div>
    {#if saveProblem}<p class="problem" role="alert">{saveProblem}</p>{/if}
    {#if ascopeError}<p class="problem" role="status">{ascopeError}</p>{/if}
  </section>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={tab === 'match'} class:active={tab === 'match'} onclick={() => (tab = 'match')}>Match</button>
    <button role="tab" aria-selected={tab === 'power'} class:active={tab === 'power'} onclick={() => (tab = 'power')}>Power</button>
    {#if devicesPath}<button role="tab" aria-selected={tab === 'devices'} class:active={tab === 'devices'} onclick={() => (tab = 'devices')}>Devices</button>{/if}
    <button role="tab" aria-selected={tab === 'limits'} class:active={tab === 'limits'} onclick={() => (tab = 'limits')}>Limits</button>
    <button role="tab" aria-selected={tab === 'logging'} class:active={tab === 'logging'} onclick={() => (tab = 'logging')}>Logging</button>
  </div>

  <main>
    {#if tab === 'match'}<MatchTab analysis={shownCurrent ?? current} {videoKey} {issues} wrong={wrongNow} real={realNow} {sure} {standing} onMark={readOnly ? undefined : mark} debug={readOnly ? undefined : debug} hoot={hootHere} onDevices={devicesPath ? () => (tab = 'devices') : undefined} />{:else if tab === 'power'}<PowerTab analysis={current} />{:else if tab === 'devices' && devicesPath}<DevicesTab analysis={current} logPath={devicesPath} onReadings={(name, r) => { keepReadings(name, r); hootTick++ }} />{:else if tab === 'limits'}<LimitsTab analysis={current} />{:else}<LoggingTab analysis={current} />{/if}
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
      <li>Get the match's log off the robot with AdvantageScope ("Download Logs"). Phoenix <code>.hoot</code> files: add them to the Library in the desktop app (they come with the robot's logs, or from a folder). Match review reads them with CTRE's converter and shows each device in the Devices tab; an experimental check (not counted) reports each device's own faults.</li>
      <li>Drop the <code>.wpilog</code> here. Add the Driver Station's <code>.dslog</code> and <code>.dsevents</code> for the same match if you have them (on the DS laptop in <code>C:\Users\Public\Documents\FRC\Log Files</code>).</li>
      <li>Read the <strong>Match</strong> tab worst first: red cost or nearly cost a match, amber is a margin eroding, grey is context.</li>
      <li>Open the <strong>Power</strong> tab for brownouts and battery health.</li>
    </ol>
    <p class="meta">Matches opened here aren't kept when the page reloads (the Session view keeps each log's summary, not the log): drop the log again.</p>
  </section>
{/if}
{/if}
</div>

<AskText />
<ExportPreview />
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
  button.button:disabled { opacity: 0.6; cursor: default; }
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
  /* Reserve the bold width, so the tabs don't shift when the active one changes. */
  .modes > button::after { content: attr(data-label); display: block; height: 0; overflow: hidden; visibility: hidden; font-weight: 600; }
  .tabs { display: flex; gap: 0.25rem; margin: 0 0 0.4rem; border-bottom: 1px solid var(--border); }
  .tabs button { padding: 0.45rem 1rem; border: none; border-bottom: 2px solid transparent; background: none; color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--focus); font-weight: 600; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
  .empty { margin-top: 1.5rem; }
  .empty h2 { font-size: 1.1rem; }
  .empty li { margin-bottom: 0.4rem; max-width: 75ch; }
  .phone-line { margin: -0.4rem 0 0.6rem; color: var(--muted); font-size: 0.85rem; }
  /* The phone: every control a finger can hit (Apple HIG 44 pt; WCAG 2.2 2.5.8 asks 24 px). */
  :global(#app.phone :is(button, select, summary, input:not([type]), input[type='text'], input[type='password'], input[type='number'])) { min-height: 44px; box-sizing: border-box; }
  :global(#app.phone .help) { min-width: 44px; border-radius: 22px; }
  :global(#app.phone) { padding-top: max(1rem, env(safe-area-inset-top)); }
  @media (max-width: 600px) {
    .modes { flex-wrap: nowrap; overflow-x: auto; }
    .modes button { flex: 1 0 auto; }
  }
  /* The phone's four places in two rows: a tab scrolled out of sight is one nobody finds (it hid "Now" at 375 px). */
  :global(#app.phone) .modes { display: grid; grid-template-columns: 1fr 1fr; overflow: visible; }
  .phone-line.warn { color: var(--warning); }
  .phone-setup { margin-top: 2rem; }
  .pick { display: flex; gap: 0.4rem; margin: 0.25rem 0 0.75rem; overflow-x: auto; padding-bottom: 0.2rem; }
  .pick button { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 52px; min-height: 44px; padding: 0.2rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  .pick small { color: var(--error); font-size: 12px; }
  .pick button.active { border-color: var(--focus); box-shadow: inset 0 0 0 1px var(--focus); }
</style>
