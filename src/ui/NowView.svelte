<!--
  Now (ADR 10): the screen the app opens on. What to do at this moment, each task one button: on an event day the next match
  and the tasks before it (pull the last log, triage, the queue check); on a practice day the start-of-practice check, today's
  runs and what is still open; with no logs, the ways to get one. The words come from src/now/now.ts (pure); this file reads the
  sessions, the board, the schedule and the library, and does what a button says. It never probes the robot: a pull is the
  only time it talks to one, and only when the button is pressed.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { hub, type RobotResult } from '../hub/bridge.ts'
  import { robotAddresses } from '../foresight/addresses.ts'
  import { buildBoard } from '../board/model.ts'
  import { sessionWithMarks } from '../triage/track-record.ts'
  import { PROFILES } from '../profiles/index.ts'
  import { profilesNow } from './kept-profiles.svelte.ts'
  import { tbaGetter, tbaHasKey, tbaTeam } from './tba-setting.svelte.ts'
  import { sessionSchedule } from '../tba/session-schedule.ts'
  import type { ScheduledMatch } from '../tba/schedule.ts'
  import { todayMode } from '../session/mode.ts'
  import { dateText } from '../session/day.ts'
  import type { Session } from '../session/session.ts'
  import type { HistoryEvent, Triage } from '../triage/history.ts'
  import { eventSessionFor, nowState, robotNotFound, stillSession, type NowAction, type NowLink, type Place } from '../now/now.ts'
  import ModeLine from './ModeLine.svelte'
  import { chooseMode, sessionNames } from './session-names.svelte.ts'
  import type { TodaySignal } from './today-signal.svelte.ts'

  // `onGo`: switch to a place. `onBoard`: the Session view's board (the app loads today's library logs into it first).
  // `onOpenLog`: files chosen for Match review; `onOpenLogs`: files chosen for the Session view. `onAdded`: logs were just
  // brought in (a pull or a folder), so the app loads today's into the Session view without switching. `openLogs`: logs open in Match review.
  let { sessions, history, marks, signal, openLogs, onGo, onBoard, onOpenLog, onOpenLogs, onAdded }: {
    sessions: Session[]; history: HistoryEvent[]; marks: Triage; signal: TodaySignal; openLogs: number
    onGo: (place: Place) => void; onBoard: () => void | Promise<void>
    onOpenLog: (files: File[]) => void; onOpenLogs: (files: File[]) => void; onAdded: () => void | Promise<void>
  } = $props()
  const api = hub()
  const build = api ? 'hub' : 'page'

  const clock = $derived(signal.clock)
  const today = $derived(todayMode(sessions, clock, sessionNames(), signal.external))
  const stored = $derived(profilesNow())

  // Today's event session (the mode line found it, or the latest of this event on its second day) and the team's schedule at it,
  // read as Foresight reads it: again only when the session, its event, the team or the key changes.
  const eventSession = $derived(today.mode === 'event' ? eventSessionFor(sessions, today.sessionId, signal.external, clock) : null)
  let schedule = $state.raw<ScheduledMatch[] | null>(null)
  let scheduleNote = $state<string | null>(null)
  const scheduleSig = $derived(eventSession ? `${eventSession.id}|${eventSession.event?.key ?? ''}|${eventSession.matches.filter((m) => m.onField).map((m) => m.matchLabel).join(',')}|${tbaTeam()}|${tbaHasKey()}` : '')
  let scheduleOf = ''
  $effect(() => {
    if (!scheduleSig) { schedule = null; scheduleNote = null; scheduleOf = ''; return }
    const s = untrack(() => eventSession)!
    const key = `${s.id}|${s.event?.key ?? ''}|${tbaTeam()}`
    if (key !== scheduleOf) { schedule = null; scheduleNote = null; scheduleOf = key }
    const [get, team] = [tbaGetter(), tbaTeam()]
    if (!get || team === null) { schedule = null; scheduleNote = null; return }
    let stale = false
    void sessionSchedule(s, team, get).then((got) => { if (!stale) { schedule = got.schedule; scheduleNote = got.note } })
    return () => { stale = true }
  })
  const profiles = $derived([...PROFILES, ...stored])
  const eventBoard = $derived(eventSession ? buildBoard({ session: sessionWithMarks(eventSession, marks), history, marks, schedule, profiles, now: new Date(clock) }) : null)
  // A practice day: what the latest event's board still has open.
  const still = $derived.by(() => {
    if (today.mode !== 'practice') return null
    const s = stillSession(sessions, today.sessionId)
    if (!s) return null
    const b = buildBoard({ session: sessionWithMarks(s.session, marks), history, marks, schedule: null, profiles, now: new Date(clock) })
    return { event: s.name, open: b.rows.length, red: b.rows.filter((i) => i.priority === 'red').length }
  })

  const day = $derived(dateText(clock))
  const libraryToday = $derived(api ? signal.libraryLogs.filter((r) => !r.stub && r.playedAt !== null && dateText(r.playedAt) === day).length : null)
  const hasLogs = $derived((api ? signal.libraryLogs.some((r) => !r.stub) : false) || sessions.length > 0 || openLogs > 0)
  const view = $derived(nowState({
    build, mode: today.mode, hasLogs, libraryToday, event: eventBoard, have: { team: tbaTeam() !== null, key: tbaHasKey() },
    scheduleNote, still, now: clock,
  }))
  // Logs added to the library from anywhere (the Library tab, a sync) while the Session view already holds a session: it does not
  // watch the library, so Now hands it today's logs again (the same ones, the new log among them) and "Pull Q33's log" can read done.
  let seenToday: number | null = null
  $effect(() => {
    const n = libraryToday
    if (n === null || !signal.libraryLoaded) return
    const was = seenToday
    seenToday = n
    if (was !== null && n > was && untrack(() => sessions.length) > 0) void onAdded()
  })
  // The desktop app has read the library once (until then it is not known whether there are logs).
  const waiting = $derived(!!api && !signal.libraryLoaded)

  // ---- the buttons ----
  let chooser: HTMLInputElement | undefined = $state()
  let chooserFor: 'open-log' | 'open-logs' = 'open-log'
  function choose(kind: 'open-log' | 'open-logs') { chooserFor = kind; chooser?.click() }
  function chosen(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return
    if (chooserFor === 'open-logs') onOpenLogs(files); else onOpenLog(files)
  }

  let note = $state('')
  let busy = $state<string | null>(null)
  let progress = $state('')
  // A pull that did not work: the words, and whether the robot did not answer (so the cable and power are the first thing to check).
  let failure = $state<{ reason: string; notFound: boolean; tried: string } | null>(null)
  $effect(() => {
    if (!api) return
    return api.onProgress((p) => { progress = p ? `${p.job}${p.total ? ` ${p.done} of ${p.total}` : '…'}` : '' })
  })

  const countText = (n: number) => `${n} log${n === 1 ? '' : 's'}`
  function reportText(r: Extract<RobotResult, { report: unknown }>['report'] | null, from: string): string {
    if (!r) return ''
    const bits = [`Added ${countText(r.added.length)} from ${from}`]
    if (r.already.length) bits.push(`${r.already.length} already in the library`)
    if (r.unreadable.length) bits.push(`${r.unreadable.length} could not be read`)
    return `${bits.join(' · ')}.`
  }

  async function pull() {
    if (!api || busy) return
    failure = null
    note = ''
    busy = 'pull'
    const addresses = robotAddresses(tbaTeam()).addresses
    const tried: string[] = []
    let reason = ''
    try {
      // USB first, then the Ethernet and by-name addresses the team number gives; the next only when the robot did not answer.
      for (const a of addresses) {
        note = `Connecting to the robot over ${a.label} (${a.value})…`
        tried.push(a.label)
        const r = await api.addFromRobot(a.value)
        if ('refused' in r) { reason = r.refused; if (robotNotFound(r.refused)) continue; break }
        note = `${reportText(r.report, 'the robot')}${r.stillWriting.length ? ` ${r.stillWriting.length} file${r.stillWriting.length === 1 ? ' was' : 's were'} skipped as still being written: pull again later.` : ''}`
        await signal.readLibrary()
        await onAdded()
        return
      }
      failure = { reason, notFound: robotNotFound(reason), tried: tried.join(', ') }
      note = ''
    } catch (e) {
      failure = { reason: e instanceof Error ? e.message : String(e), notFound: false, tried: tried.join(', ') }
      note = ''
    } finally { busy = null }
  }
  async function addFolder() {
    if (!api || busy) return
    failure = null
    note = ''
    busy = 'folder'
    try {
      const r = await api.addFromFolder()
      if (r) { note = reportText(r, 'the folder'); await signal.readLibrary(); await onAdded() }
    } catch (e) { note = e instanceof Error ? e.message : String(e) } finally { busy = null }
  }

  function run(a: NowAction) {
    switch (a.kind) {
      case 'go': failure = null; onGo(a.place); break
      case 'board': failure = null; void onBoard(); break
      case 'pull': void pull(); break
      case 'add-folder': void addFolder(); break
      case 'open-log': case 'open-logs': choose(a.kind); break
    }
  }
  const link = (l: NowLink) => run(l.action)
</script>

<!-- The same files Match review's own input takes, listed in another order so a script that picks that input by its accept list still finds it. -->
<input bind:this={chooser} class="sr" type="file" multiple accept=".wpilog,.jsonl,.dslog,.dsevents" tabindex="-1" aria-hidden="true" data-now-chooser onchange={chosen} />

<section class="now" aria-label="Now">
{#if waiting}
  <p class="meta" role="status">Reading the library…</p>
{:else if failure}
  <div class="fail" role="alert">
    <p class="head">Connecting to the robot over {failure.tried}…</p>
    {#if failure.notFound}
      <p class="bad">Robot not found.</p>
      <p>Is the USB cable in and the robot on?</p>
      <p class="meta">{failure.reason}</p>
    {:else}
      <p class="bad">{failure.reason}</p>
    {/if}
    <div class="row">
      <button type="button" class="primary" onclick={() => pull()}>Try again</button>
      <span>or</span>
      <button type="button" onclick={() => addFolder()}>Add a folder of logs</button>
      <span>or</span>
      <button type="button" onclick={() => choose('open-log')}>Open one match's log</button>
    </div>
    <p><button type="button" class="link" onclick={() => { failure = null }}>← Back to Now</button></p>
  </div>
{:else}
  <h2 class="big" data-now-big>{view.big}</h2>
  {#if view.keyLine}
    <p class="keyline" data-now-key>{view.keyLine.lead}{' '}<button type="button" class="link" onclick={() => link(view.keyLine!.link)}>{view.keyLine.link.text}</button>{view.keyLine.rest}</p>
  {:else if view.scheduleNote}
    <p class="keyline" data-now-key>{view.scheduleNote}</p>
  {/if}

  <ol class="tasks" data-now-tasks>
    {#each view.tasks as t (t.id)}
      <li class:done={t.done} data-task={t.id}>
        <span class="n" aria-hidden="true">{t.done ? '✓' : ''}</span>
        <span class="what">
          <span class="t">{t.title}{#if t.done}<span class="sr">{' '}(done)</span>{/if}</span>
          {#if t.detail}<span class="d">{t.detail}</span>{/if}
        </span>
        {#if t.button && t.action}
          <button type="button" class:primary={t.primary} disabled={!!busy && (t.action.kind === 'pull' || t.action.kind === 'add-folder')} onclick={() => run(t.action!)}>{t.button}</button>
        {/if}
      </li>
    {/each}
  </ol>
  <p class="status" role="status" data-now-note>{busy === 'folder' && !note ? 'Adding logs…' : note}{#if busy && progress}{' '}· {progress}{/if}{#if busy}{' '}<button type="button" class="link" onclick={() => api?.cancel()}>Stop</button>{/if}</p>

  {#if view.jobs.length}
    <h3 class="jobs">What Hindsight does</h3>
    <ul class="job-list">
      {#each view.jobs as j (j.job)}
        <li><span class="job">{j.job}</span><button type="button" class="link" onclick={() => run(j.action)}>{j.place}</button></li>
      {/each}
    </ul>
  {/if}
  {#if view.also.length}
    <p class="meta">Also: {#each view.also as a, i (a.text)}{#if i}{' · '}{/if}<button type="button" class="link" onclick={() => link(a)}>{a.text}</button>{/each}</p>
  {/if}
  {#if view.modeLine}
    <ModeLine text={today.line} mode={today.mode} byHand={today.byHand} onChange={(m) => chooseMode(today.sessionId, m)} hint="Changes whether Hindsight treats today as an event day (matches, the queue check) or as practice (runs, the start-of-practice check). Each log is judged from its own field data." />
  {/if}
{/if}
</section>

<style>
  .now { max-width: 62rem; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .big { font-size: 1.6rem; font-weight: 800; margin: 0.5rem 0 0.4rem; }
  .keyline { margin: 0 0 0.8rem; color: var(--fg); }
  .keyline .link { padding: 0; }
  .meta { margin: 0.3rem 0; color: var(--muted); font-size: 0.9rem; }
  button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--muted); border-radius: 4px; padding: 0.25rem 0.8rem; min-height: 32px; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  button:disabled { color: var(--muted); border-style: dashed; cursor: default; }
  /* The first thing to do is heavier by weight and border width, not by colour alone. */
  button.primary { border: 2px solid var(--fg); font-weight: 700; }
  button.link { border: none; background: none; padding: 0 0.15rem; min-height: 24px; color: var(--fg); text-decoration: underline; }
  .tasks { list-style: none; margin: 0.4rem 0 0; padding: 0; counter-reset: t; }
  .tasks > li { counter-increment: t; display: grid; grid-template-columns: 2.2rem minmax(0, 1fr) auto; gap: 0.2rem 0.8rem; align-items: center; border: 1px solid var(--border); border-radius: 6px; padding: 0.55rem 0.8rem; margin: 0.5rem 0; }
  .tasks > li .n::before { content: counter(t); font-size: 1.5rem; font-weight: 800; }
  .tasks > li.done .n::before { content: ''; }
  .tasks > li.done .n { font-size: 1.5rem; font-weight: 800; }
  .tasks > li.done { color: var(--muted); border-style: dashed; }
  .what { display: flex; flex-direction: column; }
  .t { font-size: 1.1rem; font-weight: 700; }
  .d { color: var(--muted); font-size: 0.92rem; }
  .status { min-height: 1.45em; margin: 0.3rem 0; color: var(--muted); }
  .jobs { margin: 1.2rem 0 0.2rem; font-size: 1.1rem; }
  .job-list { list-style: none; margin: 0.2rem 0; padding: 0; }
  .job-list li { padding: 0.15rem 0; border-top: 1px solid var(--border); display: flex; gap: 1rem; align-items: baseline; }
  .job { min-width: 18rem; font-weight: 700; }
  .fail { border: 2px solid var(--fg); border-radius: 6px; padding: 0.5rem 1rem 0.8rem; margin: 0.8rem 0; }
  .fail .head { font-size: 1.1rem; }
  .fail .bad { color: var(--error); font-weight: 700; }
  .fail .meta { margin: 0.3rem 0 0.7rem; }
  .fail .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
</style>
