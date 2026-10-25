<!--
  Foresight: the pre-match go/no-go, live from the robot over a tether in the pit or the queue (the team's onchecks).
  One engine, two checklists chosen by the mode line (ADR 9). In the queue (event mode) a do-confirm list of systems, each
  Go, Go with deferral or No-go, under one word (NO-GO, NOT CHECKED, GO WITH n DEFERRALS, GO); at the start of practice a
  read-do list ending "Ready to drive" or "n left", with no Go verdict. Then the findings worst first, each with the one
  thing to do before the robot goes on the field. Big enough to read at arm's length in a noisy queue.
  Read-only (src/foresight/nt4-client.ts), and never on the field: it closes for good when the field attaches.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { ForesightLive, type LiveStatus } from '../foresight/live.ts'
  import { SETTLE_SECONDS } from '../foresight/engine.ts'
  import { FIELD_MESSAGE, isFieldLocked } from '../foresight/nt4-client.ts'
  import { lastPassingSha, triage, type HistoryEvent, type PitCheckEvent } from '../triage/history.ts'
  import { howSure, trackRecord } from '../triage/track-record.ts'
  import { FORESIGHT_RULES } from '../rules/index.ts'
  import { profileId } from '../profiles/index.ts'
  import { num, values } from '../match/match.ts'
  import { isUncommitted } from '../match/git-dirty.ts'
  import { downloadText } from './download.ts'
  import { ASSISTED_RULES, checklistLines, groupSteps, markOnchecks, wantedLines } from '../foresight/onchecks.ts'
  import { boardFor, deferralSession, openDeferrals, isCarried, practiceChecklist, queueChecklist, sessionEventName, tickAt, ticksFor, tickKey, uncoveredItems, type System, type Tick } from '../foresight/checklists.ts'
  import { robotAddresses, USB_ADDRESS } from '../foresight/addresses.ts'
  import { hub } from '../hub/bridge.ts'
  import { tbaGetter, tbaHasKey, tbaTeam } from './tba-setting.svelte.ts'
  import { sessionSchedule } from '../tba/session-schedule.ts'
  import type { ScheduledMatch } from '../tba/schedule.ts'
  import type { TodaySignal } from './today-signal.svelte.ts'
  import { atLatest, boardLines } from '../board/writes.ts'
  import { readRole, writeRole } from '../board/role.ts'
  import { verdictTone } from '../report/foresight-model.ts'
  import { SNAPSHOT_RULES, type CodeSettings } from '../foresight/snapshot-checks.ts'
  import type { FolderCheck } from '../code/check/index.ts'
  import { parseSnapshot, type Snapshot } from '../snapshot/snapshot.ts'
  import type { VerdictItem } from '../foresight/verdict.ts'
  import { didNotRun } from '../report/foresight-model.ts'
  import ForesightReport from './ForesightReport.svelte'
  import ForesightQueue from './ForesightQueue.svelte'
  import ForesightPractice from './ForesightPractice.svelte'
  import CodeCheck from './CodeCheck.svelte'
  import { typedNextFor } from './typed-next.svelte.ts'
  import { codeFolder } from './code-folder.svelte.ts'
  import { changedFiles } from '../code/git.ts'
  import { codeChangeFlag } from '../board/freeze.ts'
  import { lastOnField } from '../board/points.ts'
  import ModeLine from './ModeLine.svelte'
  import { chooseMode, sessionNames } from './session-names.svelte.ts'
  import { todayMode } from '../session/mode.ts'
  import type { Session } from '../session/session.ts'
  import type { BoardRole } from '../triage/history.ts'

  let { history, onPitCheck, sessions = [], onBoard, signal }: {
    history: HistoryEvent[]; onPitCheck: (event: PitCheckEvent) => void; sessions?: Session[]
    /** Whether today is an event day by the outside signals, and the clock (App.svelte makes one, Now shares it). */
    signal: TodaySignal
    /** Writes board lines (App.svelte writeBoard): the queue checklist's ticks. Without it ticks stay on this page. */
    onBoard?: (build: (device: string, history: HistoryEvent[]) => HistoryEvent[]) => void
  } = $props()
  // A code check's "not a real problem" line beside its fix: from the marks in the history (no open logs fire code checks).
  // Null when the history holds no mark of that check, which the fix preview says as "no marks yet".
  const marksNow = $derived(triage(history))
  const anyMarks = $derived(history.some((e) => e.type === 'issue'))
  const sureCode = (rule: string): string | null => {
    const record = trackRecord(rule, marksNow, history, [])
    return record.fired === 0 ? null : howSure(record, anyMarks)
  }
  // The mode line (ADR 3): a pit check on an event day is a pit run; the laptop's day decides. With no logs of today loaded
  // (the desktop app at the pit, before the Session view has any), The Blue Alliance's schedule or a library log dated today can
  // say it is an event day too (src/session/today-event.ts). The single-file page has neither and keeps the old behaviour.
  // The schedule's events are read once (the answer for a day is worked out from them each time); the library is read again as
  // the day goes on, so a log pulled in that day flips Practice to Event without a reload. A hand choice still wins (todayMode).
  // Both signals are read once for the app (src/ui/today-signal.svelte.ts), which Now shares.
  const clock = $derived(signal.clock)
  const external = $derived(signal.external)
  // On each status update, while no event day is known, read the library again at most every 10 s.
  // Only while connected, with no event day known from either signal, and with no read in flight; neither the clock nor the answer re-runs it.
  $effect(() => { void status; if (hub() && connected && !untrack(() => external)) signal.readLibraryIfOlder(10_000) })
  const today = $derived(todayMode(sessions, clock, sessionNames(), external))

  // The Ethernet and by-name addresses are built from the team number (src/foresight/addresses.ts); USB is the same for every team.
  const offered = $derived(robotAddresses(tbaTeam()))
  const ADDRESSES = $derived(offered.addresses)
  let address = $state(USB_ADDRESS.value)
  let live: ForesightLive | null = null
  // What the Code panel read from the robot code, for the snapshot check (snapshot/code-settings).
  let codeSettings: CodeSettings | null = null
  function useCode(check: FolderCheck | null) {
    codeSettings = check && { commit: check.commit, settings: check.settings }
    live?.setCodeSettings(codeSettings)
  }
  let status = $state.raw<LiveStatus | null>(null)
  let recorded = false
  let open = $state<Record<string, boolean>>({})
  // A robot snapshot (tools/robot-snapshot.py) dropped here: Foresight never reads the diagnostic server itself.
  let snapshot = $state.raw<Snapshot | null>(null)
  let snapshotProblem = $state<string | null>(null)

  async function loadSnapshot(files: FileList | null | undefined) {
    const file = files?.[0]
    if (!file) return
    try {
      snapshot = parseSnapshot(await file.text(), file.name)
      snapshotProblem = null
    } catch (error) {
      snapshot = null
      snapshotProblem = error instanceof Error ? error.message : String(error)
    }
    live?.setSnapshot(snapshot)
  }

  function connect() {
    live?.disconnect()
    recorded = false
    // Compared with the last passing check from before this connection, not with this one.
    const since = lastPassingSha(history)
    live = new ForesightLive({ address, lastPassingSha: since, onUpdate: (s) => { status = s; record(s) } })
    live.setSnapshot(snapshot)
    live.setCodeSettings(codeSettings)
    live.start()
  }
  function disconnect() {
    live?.disconnect()
    live = null
  }
  onDestroy(() => live?.disconnect())

  // The first GO (in the queue: GO or GO WITH DEFERRALS) of a connection is kept in the history file (for foresight/commit-matches next time).
  // Practice has no Go verdict; it keeps the engine's GO as before, so the next check still compares the code with the last good one.
  function record(s: LiveStatus) {
    if (recorded || s.result?.state !== 'checked') return
    let kept: PitCheckEvent['verdict']
    if (queueMode) {
      const q = queueChecklist({ verdict: s.result.verdict, why: '', profile: s.result.match.profile, deferrals, deferralNote: null, ticks })
      if (q.kind !== 'GO' && q.kind !== 'GO WITH DEFERRALS') return
      kept = q.kind
    } else if (s.result.verdict.verdict === 'GO') kept = 'GO'
    else return
    recorded = true
    const m = s.result.match
    onPitCheck({ type: 'pit-check', verdict: kept, sha: m.build.sha, dirty: isUncommitted(m.build.dirty), robot: profileId(m.profile), when: new Date().toISOString() })
  }

  const result = $derived(status?.result ?? null)
  const checked = $derived(result?.state === 'checked' ? result : null)
  const connected = $derived(status?.state === 'connected' || status?.state === 'connecting')
  const field = $derived(status?.state === 'field' || (status === null && isFieldLocked()))
  const verdict = $derived(
    checked ? checked.verdict.verdict
      : 'NOT CHECKED',
  )
  const why = $derived(
    checked ? checked.verdict.reason
      : result?.state === 'settling' ? `${result.reason}: ${Math.ceil(result.secondsLeft)} s`
      : result?.state === 'enabled' ? result.reason
      : status?.state === 'connected' ? 'reading the robot…'
      : 'not connected',
  )
  // The checklist the mode line chooses (ADR 3, 9): event mode is the queue's, practice the start-up one.
  const queueMode = $derived(today.mode === 'event')
  const profile = $derived(checked?.match.profile ?? status?.profile ?? undefined)
  const robotId = $derived(profile ? profileId(profile) : null)
  // Open deferrals are the board's: today's event session when there is one, else the latest event session for this robot.
  const defSession = $derived(queueMode && robotId ? deferralSession(sessions, today.sessionId, robotId) : null)
  // An earlier event's board (none of today's loaded): only what it deferred to the next event is still open, and its ticks are not today's.
  const carried = $derived(!!defSession && isCarried(defSession, today.sessionId, external, clock))
  // The team's schedule for the deferral session (the Session view's own read, src/tba/session-schedule.ts), so due points and the cut-off default
  // place the same here. An earlier event's carried board never reads one; no key, no team, offline with no saved copy or an error: none (by name only).
  let fsSchedule = $state.raw<ScheduledMatch[] | null>(null)
  const scheduleSig = $derived(defSession && !carried ? `${defSession.id}|${defSession.event?.key ?? ''}|${defSession.matches.filter((m) => m.onField).map((m) => m.matchLabel).join(',')}|${tbaTeam()}|${tbaHasKey()}` : '')
  // The schedule is dropped only when the session or its event changes (or there is nothing to read), or the team changes; not on every new log of the same session: until the fresh read lands, the last one stands.
  let fsScheduleOf = ''
  $effect(() => {
    if (!scheduleSig) { fsSchedule = null; fsScheduleOf = ''; return }
    const s = untrack(() => defSession)!
    const key = `${s.id}|${s.event?.key ?? ''}|${tbaTeam()}`
    if (key !== fsScheduleOf) { fsSchedule = null; fsScheduleOf = key }
    const [get, team] = [tbaGetter(), tbaTeam()]
    if (!get || team === null) { fsSchedule = null; return }
    let stale = false
    void sessionSchedule(s, team, get).then((got) => { if (!stale) fsSchedule = got.schedule })
    return () => { stale = true }
  })
  const board = $derived(defSession && profile ? boardFor(defSession, history, profile, new Date(), carried ? null : fsSchedule, carried ? null : typedNextFor(defSession)) : null)
  const deferrals = $derived(board && profile && defSession ? openDeferrals(board, profile, carried ? sessionEventName(defSession) : undefined) : null)
  const deferralNote = $derived(!queueMode ? null : !robotId ? 'The robot is not identified yet, so no deferrals are read.' : !defSession ? 'No event session for this robot is loaded in the Session view, so no deferrals are read.' : null)
  // The role this laptop ticks under (the same setting as the board's), and ticks when no event is loaded to file them with.
  let role = $state<BoardRole | null>((() => { try { return readRole(localStorage) } catch { return null } })())
  function chooseRole(r: BoardRole | null) { role = r; if (r) { try { writeRole(localStorage, r) } catch { /* kept for this visit */ } } }
  let localTicks = $state<Partial<Record<System, { role: string; when: string }>>>({})
  const ticks = $derived.by((): Map<System, Tick> => {
    if (!queueMode || !robotId) return new Map()
    void clock // moves every 30 s: a tick goes old after TICK_MINUTES
    if (defSession && board && !carried) return ticksFor(history, robotId, defSession, board.tickFor, clock)
    return new Map(Object.entries(localTicks).map(([k, t]) => [k as System, tickAt(t!.role, t!.when, clock)] as const))
  })
  // After the playoff cut-off (ADR 7; today's event only, never an earlier event's carried board): the banner, and an amber flag when the
  // robot's code (commit, uncommitted flag) differs from the team's last on-field match's. It never moves the word.
  const playoffs = $derived(!!board && !carried && board.cutOff.passed)
  const codeChange = $derived.by(() => {
    if (!board || !defSession || !playoffs) return null
    const last = lastOnField(defSession)
    return codeChangeFlag(board.cutOff, checked ? { sha: checked.match.build.sha, dirty: isUncommitted(checked.match.build.dirty) } : null, last && board.tl.last ? { label: board.tl.last.label, build: last.build } : undefined)
  })
  // The files between the two commits, when the code folder (or GitHub) can read both. Read-only; a failure just leaves the list out.
  let changedList = $state<{ files: string[] } | { problem: string } | null>(null)
  let changedRun = 0
  // Keyed on the two commits, not on the flag object (a new object on every recompute, so on every clock tick): one read per change.
  const changeKey = $derived(codeChange?.kind === 'changed' && codeChange.from && codeChange.to ? `${codeChange.from}..${codeChange.to}` : null)
  $effect(() => {
    const key = changeKey
    const code = codeFolder.current
    void codeFolder.version
    const run = ++changedRun
    if (!key || !code) { changedList = null; return }
    const [from, to] = key.split('..')
    changedFiles(code.repo, from, to).then(
      (files) => { if (run === changedRun) changedList = { files } },
      (error) => { if (run === changedRun) changedList = { problem: error instanceof Error ? error.message : String(error) } },
    )
  })
  const queue = $derived(queueMode ? queueChecklist({ verdict: checked?.verdict ?? null, why, profile, deferrals, deferralNote, ticks, freeze: board && playoffs && board.cutOff.banner ? { banner: board.cutOff.banner, change: codeChange } : null }) : null)
  const practice = $derived(practiceChecklist(markOnchecks(checked), uncoveredItems(checked?.verdict ?? null)))
  // The word in the big box (and on the printed report): the queue's, or the practice list's end, never a Go in practice.
  const shownWord = $derived(queue ? queue.word : checked ? (practice.ready ? 'Ready to drive' : `${practice.actions.length} left`) : 'NOT CHECKED')
  const shownWhy = $derived(queue ? queue.reason : checked ? (practice.ready ? 'every live check on the practice-start list is done' : practice.actions.join(', ')) : why)
  const shownTone = $derived(verdictTone(shownWord))
  // Not connected (never, or the connection closed): the box says what to do, and a connect whose socket closed before any value (no robot answered) says it is not a failed check.
  const notConnected = $derived(shownWord === 'NOT CHECKED' && !checked && !connected && result === null)
  const robotNotFound = $derived(status?.state === 'closed' && status.valuesReceived === 0 && status.message.startsWith('Connection closed'))
  function tick(system: System, on: boolean) {
    if (!role) return
    if (defSession && board && robotId && onBoard && !carried) {
      const r = role, forMatch = board.tickFor, robot = robotId, at = atLatest(defSession)
      onBoard((device, h) => boardLines(h, { device, role: r }, new Date(), { key: tickKey(system), robot }, [{ op: on ? 'checked' : 'unchecked', value: forMatch }], at))
    } else localTicks = on ? { ...localTicks, [system]: { role, when: new Date().toISOString() } } : Object.fromEntries(Object.entries(localTicks).filter(([k]) => k !== system))
  }
  const fmt = (t: number | null) => (t === null ? '—' : `${t.toFixed(1)} s`)
  // A few live values to compare with the Driver Station's own display.
  const lastNumber = (key: string) => { const s = checked ? num(checked.match, key) : null; return s && s.v.length ? s.v[s.v.length - 1] : null }
  const lastText = (key: string) => { const s = checked ? values<string>(checked.match, key) : null; return s && s.v.length ? s.v[s.v.length - 1] : null }
  const battery = $derived(checked ? lastNumber(checked.match.profile.signals.batteryVoltage) : null)
  const controllers = $derived(checked ? (checked.match.profile.foresight?.controllerNames ?? []).map((key) => lastText(key) || '(nothing)') : [])

  // Everything on this screen plus what the robot never sent, as a file for Claude (the first-robot checklist asks for it).
  function downloadReadings() {
    if (!status) return
    const store = live?.store
    const neverSent = status.subscribed.filter((k) => !store?.entries.get(k)?.t.length)
    const report = {
      schema: 'hindsight.foresight-readings/2', when: new Date().toISOString(), browser: navigator.userAgent, page: location.href.startsWith('file:') ? 'file://' : location.origin,
      url: status.url, state: status.state, message: status.message, topicsAnnounced: status.topicsAnnounced, signalsAskedFor: status.subscribed.length,
      valuesReceived: status.valuesReceived, robotTime: status.robotTime, codeStart: status.codeStart, codeStartFrom: status.codeStartFrom,
      robot: status.profile ? profileId(status.profile) : null, neverSent, battery, controllers,
      snapshot: snapshot && { file: snapshot.fileName, takenAt: snapshot.takenAt, devices: snapshot.devices.length, stopped: snapshot.stopped, responseShapes: snapshot.responseShapes, used: checked?.snapshotUsed ?? null },
      checklist: queue ? { kind: 'queue', word: queue.word, systems: queue.rows.map((r) => [r.system, r.word]), openDeferrals: queue.deferrals.length } : { kind: 'practice', end: practice.end },
      verdict: checked ? { verdict: checked.verdict.verdict, reason: checked.verdict.reason, items: checked.verdict.items.map(readingItem), notChecked: checked.verdict.notChecked, crashed: checked.verdict.crashed, build: checked.match.build } : result,
    }
    downloadText(`foresight-readings-${report.when.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(report, null, 1))
  }
  type ReadingItem = { level: string; rule: string; title: string; explains?: ReadingItem[] }
  const readingItem = (i: VerdictItem): ReadingItem => ({ level: i.level, rule: i.finding.rule, title: i.finding.title, ...(i.explains.length ? { explains: i.explains.map(readingItem) } : {}) })
  const onchecks = $derived(checklistLines(checked))
  // Problems no check can see yet (rules/wanted.ts): grey context, never in the verdict.
  const wanted = $derived(wantedLines(checked))
  // Only red and amber items decide GO/NO-GO; grey ones (context, or a step for a person) sit in their own short list.
  // One headline per event: a finding already on a No-go row of the queue (with its action and proof) is not listed again.
  const decisive = $derived(checked ? checked.verdict.items.filter((i) => i.level !== 'grey' && !queue?.rows.some((r) => r.fix.includes(i))) : [])
  // Grey items that ask a person to do something (hold a tag up to a camera) are steps; the other greys are context.
  // In practice the camera step is on its checklist line ("Left: do", with the cameras named), so it is not listed again.
  const stepItems = $derived(checked && queue ? groupSteps(checked.verdict.items.filter((i) => i.level === 'grey' && ASSISTED_RULES.has(i.finding.rule))) : [])
  const contextItems = $derived(checked ? checked.verdict.items.filter((i) => i.level === 'grey' && !ASSISTED_RULES.has(i.finding.rule)) : [])
  const totalChecks = FORESIGHT_RULES.length + SNAPSHOT_RULES.length
  // Reds the board has deferred, by finding key (queue mode): worded as deferred wherever they are listed.
  const deferredBy = $derived<Record<string, string>>(Object.fromEntries((queue?.deferrals ?? []).map((d) => [d.key, d.workaround || 'none written'])))
  const deferredLine = (i: VerdictItem): string | null => (i.level === 'red' ? deferredBy[i.finding.key] ?? null : null)
  const unrun = $derived(checked ? didNotRun(checked.verdict.notChecked.length + checked.verdict.crashed.length, totalChecks) : null)
  const snapshotWhy = $derived(checked && !checked.snapshotUsed ? checked.report.skipped.find((s) => s.rule === SNAPSHOT_RULES[0])?.reason ?? null : null)
  let reportView = $state<{ save: () => Promise<string | null> }>()
  let saveProblem = $state<string | null>(null)
  const LEVEL_WORD = { red: 'Fix before the field', amber: 'Look at', grey: 'Context' } as const
</script>

{#snippet itemRow(item: VerdictItem, nested = false)}
  <li class={`item ${deferredLine(item) !== null ? 'deferred' : item.level}`}>
    <button class="row" onclick={() => (open = { ...open, [item.finding.key]: !open[item.finding.key] })} aria-expanded={!!open[item.finding.key]}>
      <span class="chip">{deferredLine(item) !== null ? 'Deferred' : ASSISTED_RULES.has(item.finding.rule) && item.level === 'grey' ? 'Do' : LEVEL_WORD[item.level]}</span>
      <span class="title">{item.finding.title}</span>
    </button>
    {#if nested}<p class="action">↳ {item.finding.explainedBy?.why}</p>
    {:else if deferredLine(item) !== null}<p class="action"><strong>DEFERRED · workaround:</strong> {deferredLine(item)}</p>
    {:else if item.level !== 'grey' || ASSISTED_RULES.has(item.finding.rule)}<p class="action"><strong>Do:</strong> {item.action}</p>{/if}
    {#if !nested && item.finding.explainedBy}<p class="proof">explained by {item.finding.explainedBy.rule}: {item.finding.explainedBy.why}</p>{/if}
    <p class="proof">{item.finding.rule} · {item.proof}</p>
    {#if open[item.finding.key]}
      <div class="detail">
        <p>{item.finding.meaning}</p>
        <dl>{#each Object.entries(item.finding.evidence) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
        <p class="small">Could be: {item.finding.causes.map((c) => `${c.cause} (${c.look})`).join('; ')}</p>
      </div>
    {/if}
    {#if item.explains.length}
      <ol class="items under" aria-label="The same problem, seen by other checks">
        {#each item.explains as under (under.finding.key + under.finding.title)}{@render itemRow(under, true)}{/each}
      </ol>
    {/if}
  </li>
{/snippet}

<!-- A file dropped anywhere but the snapshot box would open in this tab and end the check. -->
<svelte:window ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />
<div class="screen-only">
<ModeLine text={today.line} mode={today.mode} byHand={today.byHand} onChange={(m) => chooseMode(today.sessionId, m)} hint="Changes how this session's logs are grouped and counted (matches or logs, pit runs, trends). Each log is judged from its own field data." />
{#if field}
  <section class="field" role="alert">
    <p class="big">{FIELD_MESSAGE}</p>
    <p>Foresight disconnected the moment the field attached and will not connect again until this page is reloaded off the field.</p>
  </section>
{:else}
  <section class="connect">
    <label>Robot <input list="foresight-addresses" bind:value={address} disabled={connected} size="24" /></label>
    <datalist id="foresight-addresses">{#each ADDRESSES as a (a.value)}<option value={a.value}>{a.label}</option>{/each}</datalist>
    {#if offered.note}<span class="status">{offered.note}</span>{/if}
    {#if connected}<button class="button" onclick={disconnect}>Disconnect</button>{:else}<button class="button" onclick={connect}>Connect</button>{/if}
    <span class="status">{status?.message ?? 'Tethered in the pit or queue (USB or Ethernet), robot on, Driver Station connected. Never on the field.'}</span>
  </section>

  <section class="connect" aria-label="Robot snapshot" ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); loadSnapshot(e.dataTransfer?.files) }}>
    <label class="button">Robot snapshot… <input type="file" accept=".json,application/json" hidden onchange={(e) => { const input = e.currentTarget as HTMLInputElement; loadSnapshot(input.files); input.value = '' }} /></label>
    <span class="status">
      {#if snapshotProblem}{snapshotProblem}
      {:else if !snapshot}For the CAN devices, CANcoder offsets, swerve ratio and current limits: once this page has a verdict, run <code>python3 tools/robot-snapshot.py</code> (robot on, not enabled), then choose or drop its <code>snapshot.json</code> here. Don't press Clear Faults or blink first.
      {:else}<code>{snapshot.fileName}</code>, taken {snapshot.takenAtLocal}: {snapshot.devices.length} devices{snapshot.stopped ? ' (stopped early: incomplete)' : ''}{checked ? (checked.snapshotUsed ? '. Used for this check.' : `. Not used: ${snapshotWhy}`) : ''}
        <button class="button" onclick={() => { snapshot = null; live?.setSnapshot(null) }}>Remove</button>{/if}
    </span>
  </section>

  <section class={`verdict t-${shownTone}`} aria-live="polite">
    <p class="big">{shownWord}{#if notConnected}<span class="tail">: connect the robot first.</span>{/if}</p>
    {#if notConnected && robotNotFound}<p>Robot not found: is the cable in? This is not a failed check.</p>{/if}
    <p>{notConnected ? 'Tether it (USB or Ethernet), robot on, Driver Station connected, then Connect.' : shownWhy}</p>
    {#if unrun}<p class="unrun">{unrun}</p>{/if}
    {#if result?.state === 'settling'}<p class="small">Nothing is judged until {SETTLE_SECONDS} s after the robot code starts: start-up camera and time-sync alerts clear in that time.</p>{/if}
    {#if checked?.hoot}<p class="small">{checked.hoot.text}</p>{/if}
  </section>

  {#if !queue && status}
    <ForesightPractice checklist={practice} />
  {/if}

  {#if queue && status}
    <ForesightQueue checklist={queue} changed={changedList} codeChosen={!!codeFolder.current} {role} {ticks} forLabel={board?.tickLabel ?? 'the next match'} filed={!!(defSession && board && onBoard && !carried)} onTick={tick} onRole={chooseRole} />
  {/if}

  {#if checked}
    {#if decisive.length}
      <ol class="items" aria-label="Findings that decide GO or NO-GO">
        {#each decisive as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
      </ol>
    {/if}
    {#if stepItems.length}
      <ol class="items context-items" aria-label="Steps for a person: never changes the verdict">
        {#each stepItems as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
      </ol>
    {/if}
    {#if contextItems.length}
      <details class="inert">
        <summary>{contextItems.length} context {contextItems.length === 1 ? 'note' : 'notes'}: never {contextItems.length === 1 ? 'changes' : 'change'} the verdict</summary>
        <ol class="items context-items" aria-label="Context: never changes the verdict">
          {#each contextItems as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
        </ol>
      </details>
    {/if}
    {#if checked.verdict.notChecked.length || checked.verdict.crashed.length}
      <details class="notchecked">
        <summary>Not checked or partly checked: {checked.verdict.notChecked.length + checked.verdict.crashed.length} of {totalChecks} checks</summary>
        <ul>
          {#each checked.verdict.notChecked as s (s.rule)}<li><code>{s.rule}</code>: {s.reason}</li>{/each}
          {#each checked.verdict.crashed as s (s.rule)}<li><code>{s.rule}</code> crashed: {s.reason}</li>{/each}
        </ul>
      </details>
    {/if}
  {/if}

  {#if status}
    <section class="onchecks" aria-label="Wanted checks">
      {#if wanted.length}
        <details class="inert">
          <summary>{wanted.length} wanted checks: problems no check can see yet (context, never changes the verdict)</summary>
          <ul aria-label="Wanted checks: context, never changes the verdict">
            {#each wanted as w (w.id)}<li class="oc wanted"><span class="mark">Wanted</span><span class="line">{w.question}</span><span class="detail-text">{w.detail}</span></li>{/each}
          </ul>
        </details>
      {/if}
    </section>
  {/if}

  <CodeCheck playoffs={playoffs} sure={sureCode} robotSha={checked?.match.build.sha || null} robotDirty={!!checked && isUncommitted(checked.match.build.dirty)} suggest={status?.profile?.code} onchecked={useCode} />

  {#if status && status.state !== 'closed'}
    <details class="readings" open>
      <summary>Readings</summary>
      <dl>
        <dt>Connected to</dt><dd><code>{status.url}</code></dd>
        <dt>Topics announced / signals asked for</dt><dd>{status.topicsAnnounced} / {status.subscribed.length}</dd>
        <dt>Values received</dt><dd>{status.valuesReceived.toLocaleString()}</dd>
        <dt>Robot time</dt><dd>{fmt(status.robotTime)}{#if status.codeStart !== null} · code started at {fmt(status.codeStart)} (from the {status.codeStartFrom}){/if}</dd>
        <dt>Robot</dt><dd>{status.profile ? profileId(status.profile) : '—'}</dd>
        {#if checked}
          <dt>Battery now</dt><dd>{battery === null ? '—' : `${battery.toFixed(2)} V`}</dd>
          <dt>Controllers</dt><dd>{controllers.map((c, i) => `${i}: ${c}`).join(' · ') || '—'}</dd>
          <dt>Code</dt><dd><code>{checked.match.build.sha.slice(0, 7) || '?'}</code> on {checked.match.build.branch || '?'} · {checked.match.build.dirty || '?'}</dd>
          <dt>Checked stretch</dt><dd>{fmt(checked.start)} to {fmt(checked.end)}</dd>
        {/if}
      </dl>
      <button class="button" onclick={downloadReadings} title="Saves foresight-readings-….json: these readings, the verdict, and which signals the robot never sent">Download for Claude</button>
      <button class="button" onclick={async () => { saveProblem = (await reportView?.save()) ?? null }} title="Opens the print dialog: choose Save as PDF. Also saves a phone-sized card (PNG) to post in Slack with it.">Save for Slack</button>
      {#if saveProblem}<p class="small" role="alert">{saveProblem}</p>{/if}
    </details>
  {/if}
{/if}
</div>
<ForesightReport bind:this={reportView} {totalChecks} {status} {checked} verdict={shownWord} why={shownWhy} deferred={deferredBy} {onchecks} {battery} {controllers} />

<style>
  .connect + .connect { margin-top: 0.5rem; }
  .connect { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: 8px; }
  .connect input { font: inherit; padding: 0.25rem 0.4rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .status { color: var(--muted); font-size: 0.85rem; flex: 1 1 18rem; }
  .button { padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .verdict { margin: 1rem 0; padding: 1.25rem 1rem; border-radius: 10px; text-align: center; border: 2px solid var(--border); }
  .big .tail { font-size: clamp(1.1rem, 3vw, 1.6rem); letter-spacing: 0; }
  .big { font-size: clamp(2rem, 9vw, 4rem); font-weight: 800; margin: 0; letter-spacing: 0.02em; }
  .verdict p { margin: 0.25rem 0; }
  .small { font-size: 0.8rem; color: var(--muted); }
  .verdict .unrun { font-size: 1rem; color: var(--muted); }
  details > summary { min-height: 24px; box-sizing: border-box; }
  /* The word carries the meaning; the colour only helps (WCAG 1.4.1). A go with deferrals is amber, never green. */
  .t-ok { border-color: var(--go, #188038); color: var(--go, #188038); }
  .t-error { border-color: var(--error); color: var(--error); }
  .t-warning { border-color: var(--warning); color: var(--warning); }
  .t-muted { color: var(--muted); }
  .items { list-style: none; padding: 0; margin: 0; }
  .item { border-left: 4px solid var(--border); padding: 0.4rem 0.75rem; margin: 0 0 0.5rem; }
  .item.red { border-left-color: var(--error); }
  .item.amber, .item.deferred { border-left-color: var(--warning); }
  .items.under { margin: 0.4rem 0 0; }
  .under .item { margin-bottom: 0; }
  .row { display: flex; gap: 0.6rem; align-items: baseline; width: 100%; text-align: left; border: none; background: none; color: var(--fg); font: inherit; cursor: pointer; padding: 0; }
  .chip { font-size: 0.75rem; font-weight: 700; white-space: nowrap; }
  .red .chip { color: var(--error); }
  .amber .chip, .deferred .chip { color: var(--warning); }
  .grey .chip { color: var(--muted); }
  .title { font-weight: 600; font-size: 1.1rem; }
  .action, .proof { margin: 0.15rem 0 0; font-size: 0.9rem; }
  .proof { color: var(--muted); font-size: 0.8rem; }
  .detail { font-size: 0.85rem; margin-top: 0.4rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; margin: 0.4rem 0; font-size: 0.85rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .notchecked, .readings { margin-top: 1rem; font-size: 0.85rem; }
  .onchecks { margin-top: 1rem; }
  .onchecks ul { list-style: none; margin: 0; padding: 0; }
  .oc { display: grid; grid-template-columns: 6.5rem minmax(10rem, 1fr) 2fr; gap: 0.15rem 0.75rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; align-items: baseline; }
  .oc .mark { font-weight: 700; font-size: 0.8rem; }
  .oc.ok .mark { color: var(--muted); font-weight: 400; }
  .oc.not-checked .mark { color: var(--fg); }
  .inert { margin-top: 0.4rem; }
  .inert summary { color: var(--muted); font-size: 0.85rem; cursor: pointer; padding: 0.25rem 0; }
  .inert ul { list-style: none; margin: 0; padding: 0; }
  .context-items { margin-top: 0.75rem; }
  .oc.red .mark { color: var(--error); }
  .oc.amber .mark { color: var(--warning); }
  .oc.to-do .mark { color: var(--fg); }
  .oc.context .mark, .oc.by-eye .mark, .oc.wanted .mark { color: var(--muted); }
  .oc .detail-text { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  @media (max-width: 600px) { .oc { grid-template-columns: 5.5rem 1fr; } .oc .detail-text { grid-column: 2; } }
  .field { margin: 2rem 0; padding: 2rem 1rem; text-align: center; border: 3px solid var(--error); border-radius: 10px; color: var(--error); }
  .field .big { font-size: clamp(1.5rem, 6vw, 2.75rem); }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) { --go: #81c995; } }
</style>
