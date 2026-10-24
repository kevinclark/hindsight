<!--
  The issue board (ADR 4): what must be done before our next match, and by whom. The Session view opens on it in event mode.
  Screens: the board, one issue, the handoff, "Missed by Hindsight" and the queue sheet. Every change is a board line (or an
  event-note) appended to the team's history by `onWrite`, under this laptop's role and device id, never a name. All the
  decisions are in src/board/ (pure); this file draws them and turns clicks into lines.
-->
<script lang="ts">
  import type { Session } from '../session/session.ts'
  import type { RobotProfile } from '../profiles/types.ts'
  import type { ScheduledMatch } from '../tba/schedule.ts'
  import type { BoardRole, HistoryEvent, Triage } from '../triage/history.ts'
  import { buildBoard, eventIdOf, ruleRates, PRIORITY_WORDS, RED_CAP, type BoardIssue } from '../board/model.ts'
  import { queueSheet, type QueueSheet } from '../board/sheets.ts'
  import { FAMILIES } from '../board/model.ts'
  import { readRole, ROLES, writeRole } from '../board/role.ts'
  import { atLatest, boardLines, greyClose, greyTake, noteLine, type Change, type Who } from '../board/writes.ts'
  import { durText } from '../board/points.ts'
  import BoardRow from './BoardRow.svelte'
  import BoardRates from './BoardRates.svelte'
  import BoardIssueDetail from './BoardIssueDetail.svelte'
  import DebugWorkspace from './DebugWorkspace.svelte'
  import { makerOf } from '../rules/index.ts'
  import { rowTitle } from '../board/words.ts'
  import BoardHandoff from './BoardHandoff.svelte'
  import BoardMissed from './BoardMissed.svelte'
  import BoardQueue from './BoardQueue.svelte'

  type Build = (device: string, history: HistoryEvent[]) => HistoryEvent[]
  let { session, history, marks, schedule, scheduleNote, profiles, onWrite, printOut = $bindable(null) }: {
    session: Session; history: HistoryEvent[]; marks: Triage; schedule: ScheduledMatch[] | null; scheduleNote: string | null; profiles: RobotProfile[]
    onWrite: (build: Build) => void
    /** The queue sheet while it is open (SessionView prints it in place of the session report). */
    printOut?: { sheet: QueueSheet; title: string } | null
  } = $props()

  const store = (): Storage | null => { try { return localStorage } catch { return null } }
  let role = $state<BoardRole | null>((() => { const s = store(); return s ? readRole(s) : null })())
  function chooseRole(v: string) {
    role = ROLES.includes(v as BoardRole) ? (v as BoardRole) : null
    const s = store()
    if (role && s) writeRole(s, role)
  }

  type View = 'board' | 'issue' | 'debug' | 'handoff' | 'missed' | 'queue'
  let view = $state<View>('board')
  let openKey = $state<string | null>(null)
  let group = $state<'urgency' | 'mechanism'>('urgency')

  // The clock the time left counts from; it moves on every half minute so "≈ 61 min left" stays true while the page is open.
  let now = $state(new Date())
  $effect(() => { const t = setInterval(() => (now = new Date()), 30_000); return () => clearInterval(t) })
  const board = $derived(buildBoard({ session, history, marks, schedule, profiles, now }))
  const rates = $derived(ruleRates(session, marks, history))
  const issue = $derived(openKey ? board.issues.find((i) => i.key === openKey) : undefined)
  const sheet = $derived(queueSheet(board))
  const title = $derived(session.label)
  const next = $derived(board.strip.nextLabel ?? 'the next match')

  $effect(() => { printOut = view === 'queue' ? { sheet, title } : null; return () => { printOut = null } })

  function open(key: string) { openKey = key; view = 'issue' }
  const back = () => { view = 'board'; openKey = null }

  function write(make: (who: Who, history: HistoryEvent[]) => HistoryEvent[]) {
    const r = role
    if (!r) return
    onWrite((device, h) => make({ device, role: r }, h))
  }
  const change = (i: BoardIssue, changes: Change[]) => write((who, h) => boardLines(h, who, new Date(), i, changes, atLatest(session)))
  const note = (kind: 'pit-change' | 'missed' | 'handoff-read', text: string) => write((who, h) => [noteLine(h, who, new Date(), kind, eventIdOf(session), board.tl.last?.label ?? '', text)])
  const grey = (i: BoardIssue, what: 'close' | 'take') => change(i, what === 'close' ? greyClose() : greyTake(role!))

  // The pit line for the latest match, editable.
  const pitNow = $derived(board.pitLines.find((p) => p.match === board.tl.last?.label)?.text ?? '')
  let pitText = $state('')
  let pitSeen = $state<string | null>(null)
  $effect(() => { if (pitSeen !== pitNow) { pitSeen = pitNow; pitText = pitNow } })

  const redsNote = $derived.by(() => { const p = [board.strip.deferredReds ? `${board.strip.deferredReds} deferred` : '', board.strip.awaitingReds ? `${board.strip.awaitingReds} closed, awaiting a clean match` : ''].filter(Boolean); return p.length ? ` (${p.join(', ')})` : '' })
  const unit = (n: number, one: string, many: string) => (n === 1 ? one : many)
  const mechs = $derived([...new Set([...board.rows.map((i) => i.mechanism)])].sort((a, b) => (FAMILIES.includes(a) ? 1 : 0) - (FAMILIES.includes(b) ? 1 : 0) || a.localeCompare(b)))
  const pinned = $derived(board.visible.filter((i) => i.cls === 'due' || (i.due.pos <= board.tl.nextPos && i.status !== 'deferred' && !i.grey)))
  const SECT = $derived([['due', `Deferrals due before ${next}`], ['new', `New since the last handoff`], ['carried', 'Carried']] as const)
  const belowParts = $derived([
    board.below.filter((i) => i.priority === 'red' && !i.grey).length && `${board.below.filter((i) => i.priority === 'red' && !i.grey).length} red over the cap of ${RED_CAP}`,
    board.below.filter((i) => i.priority !== 'red' && !i.grey && i.status !== 'deferred').length && `${board.below.filter((i) => i.priority !== 'red' && !i.grey && i.status !== 'deferred').length} amber or low`,
    board.below.filter((i) => i.status === 'deferred').length && `${board.below.filter((i) => i.status === 'deferred').length} deferred past ${next}`,
    board.below.filter((i) => i.grey).length && `${board.below.filter((i) => i.grey).length} grey`,
  ].filter(Boolean).join(' · '))
  const classOf = (i: BoardIssue) => (i.cls === 'later' || i.cls === 'grey' ? 'carried' : i.cls)
</script>

<div class="board" data-board>
  <p class="whoami">
    <label>You are on: <select aria-label="Your role" title="Your role: kept on this laptop; changes are recorded under it, never a name" value={role ?? ''} onchange={(e) => chooseRole((e.currentTarget as HTMLSelectElement).value)}>
      {#if !role}<option value="" disabled>choose…</option>{/if}
      {#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
    </select></label>
    {#if !role}<span class="note">Choose it to make changes.</span>{/if}
    <button type="button" class="help" aria-label="Your role is kept on this laptop. Changes are recorded under the role, never a name." title="Your role is kept on this laptop. Changes are recorded under the role, never a name.">?</button>
  </p>

  {#if view === 'board'}
    <p class="gate" data-gate><b>{board.strip.gate}</b> {unit(board.strip.gate, 'red', 'reds')} {board.strip.over ? 'open · the event is over' : `due before ${next}`}</p>
    <p class="sub strip" data-strip>
      {#if board.strip.minutesWord}<span>{board.strip.minutesWord}</span>{/if}
      <span><b>{board.strip.deferralsDue}</b> {unit(board.strip.deferralsDue, 'deferral', 'deferrals')} due</span>
      <span><b>{board.strip.noOwner}</b> with no owner</span>
      <span><b>{board.strip.reds}</b> {unit(board.strip.reds, 'red', 'reds')} in all{redsNote}</span>
      {#if board.strip.nextGap}<span>Next gap: <strong>{board.strip.nextGap}</strong></span>{/if}
    </p>
    <div class="toolbar">
      <button type="button" class="primary" onclick={() => (view = 'queue')}>Queue sheet (print)</button>
      <button type="button" onclick={() => (view = 'handoff')}>Handoff{board.handoff ? '' : ' (not read yet)'}</button>
      <button type="button" onclick={() => (view = 'missed')}>Missed by Hindsight</button>
      <span class="grow"></span>
      <span class="small muted">View:</span>
      <span class="seg" role="group" aria-label="Group rows">
        <button type="button" aria-pressed={group === 'urgency'} onclick={() => (group = 'urgency')}>By urgency</button>
        <button type="button" aria-pressed={group === 'mechanism'} onclick={() => (group = 'mechanism')}>By mechanism</button>
      </span>
    </div>

    {#if board.rows.length === 0}
      <p class="muted">Nothing on the board: no rule fired in this event's matches or pit runs{board.closed.length ? ', and every issue seen has closed' : ''}.</p>
    {/if}
    {#if group === 'urgency'}
      {#each SECT as [k, label] (k)}
        {@const rs = board.visible.filter((i) => classOf(i) === k)}
        {#if rs.length}<div class="section-head">{label} <span class="count">({rs.length})</span></div><ul class="rows">{#each rs as i (i.key)}<BoardRow issue={i} onOpen={open} {role} onGrey={grey} />{/each}</ul>{/if}
      {/each}
    {:else}
      {#if pinned.length}<div class="section-head">Due before {next} <span class="count">({pinned.length})</span></div><ul class="rows">{#each pinned as i (i.key)}<BoardRow issue={i} onOpen={open} {role} onGrey={grey} />{/each}</ul>{/if}
      {#each mechs as g (g)}
        {@const rs = board.visible.filter((i) => i.mechanism === g && !pinned.includes(i))}
        {#if rs.length}<div class="section-head">{g} <span class="count">({rs.length})</span></div><ul class="rows">{#each rs as i (i.key)}<BoardRow issue={i} onOpen={open} {role} onGrey={grey} />{/each}</ul>{/if}
      {/each}
    {/if}
    {#if board.below.length}
      <details class="below">
        <summary>{board.below.length} more below the line (cap of {RED_CAP} reds: {belowParts}) · show</summary>
        <ul class="rows">{#each board.below as i (i.key)}<BoardRow issue={i} onOpen={open} {role} onGrey={grey} />{/each}</ul>
      </details>
    {/if}
    {#if board.closed.length}
      <details class="closed">
        <summary>{board.closed.length} closed (a clean match came after the fix)</summary>
        <ul class="notes">{#each board.closed as i (i.key)}<li><span class="mech">{i.mechanism}</span> · {i.ruleTitle}<br /><span class="small muted">closed after {i.closedAt} (derived)</span></li>{/each}</ul>
      </details>
    {/if}

    {#if board.noSchedule}<p class="note wide">{board.noSchedule}{#if scheduleNote}{' '}{scheduleNote}{/if}</p>{/if}
    <h4>What we changed in the pit since the last match{board.tl.last ? ` (after ${board.tl.last.label})` : ''}</h4>
    <div class="field">
      <label for="board-pit">One line, shown on the handoff</label>
      <input id="board-pit" type="text" bind:value={pitText} onkeydown={(e) => { if (e.key === 'Enter' && role && pitText.trim() !== pitNow) note('pit-change', pitText.trim()) }} />
    </div>
    <button type="button" disabled={!role || !board.tl.last || pitText.trim() === pitNow} onclick={() => note('pit-change', pitText.trim())}>Save the pit line{role ? ` as ${role}` : ''}</button>

    {#if scheduleNote && !board.noSchedule}<p class="note">{scheduleNote}</p>{/if}
    <BoardRates {rates} />
  {:else if view === 'issue' && issue}
    <BoardIssueDetail {issue} {board} rate={rates.find((r) => r.rule === issue.rule)} {role} onBack={back} onChange={(c) => change(issue, c)} onDebug={() => (view = 'debug')} />
  {:else if view === 'debug' && issue}
    <DebugWorkspace title={rowTitle(issue)} rule={issue.rule} meaning={makerOf(issue.rule)?.meaning ?? issue.title} latest={issue.title} causes={makerOf(issue.rule)?.causes ?? []} likely={issue.latest?.likely} ruledOut={issue.latest?.ruledOut} evidence={issue.latest?.evidence}
      nextStep={issue.nextStep} marks={issue.causeMarks} {role} backLabel="Issue" onBack={() => (view = 'issue')} onChange={(c) => change(issue, c)} />
  {:else if view === 'handoff'}
    <BoardHandoff {board} {role} onBack={back} onOpen={open} onRead={() => note('handoff-read', '')} />
  {:else if view === 'missed'}
    <BoardMissed {board} {role} onBack={back} onFile={(t) => note('missed', t)} />
  {:else if view === 'queue'}
    <BoardQueue {sheet} {role} onBack={back} onTick={(i, on) => change(i, [{ op: on ? 'checked' : 'unchecked', value: sheet.forMatch }])} />
  {:else}
    <p>No such issue. <button type="button" class="link" onclick={back}>Back to the board</button></p>
  {/if}
</div>

<style>
  .board { --add: #0b6b2a; margin-top: 0.5rem; }
  .board :global(.muted) { color: var(--muted); }
  .board :global(.small) { font-size: 0.85rem; }
  .board :global(.hint) { color: var(--muted); font-size: 0.85rem; }
  .board :global(.note) { color: var(--muted); font-size: 0.85rem; max-width: 80ch; margin: 0.2rem 0; }
  .board :global(.note.wide) { max-width: none; }
  .board :global(.problem) { color: var(--error); }
  .whoami { margin: 0.2rem 0; font-size: 0.85rem; color: var(--muted); }
  .help { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; box-sizing: border-box; border: 1px solid var(--muted); border-radius: 50%; font-size: 0.8rem; font-weight: 700; cursor: help; color: var(--fg); }
  .help:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .gate { font-size: 1.6rem; margin: 0.2rem 0 0; line-height: 1.15; }
  .gate b { font-size: 2rem; font-variant-numeric: tabular-nums; }
  .strip { display: flex; flex-wrap: wrap; gap: 0.2rem 1.2rem; margin: 0.1rem 0 0.5rem; }
  .board :global(.sub) { color: var(--muted); margin: 0.1rem 0; }
  .board :global(.sub strong) { color: var(--fg); }
  .board :global(h3.screen) { font-size: 1.25rem; margin: 0.3rem 0 0.2rem; }
  .board :global(h4) { font-size: 1.05rem; margin: 1.2rem 0 0.4rem; }
  .board :global(h5) { font-size: 0.95rem; margin: 0.9rem 0 0.3rem; }
  .board :global(button), .board :global(select), .board :global(input[type='text']), .board :global(textarea) { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--muted); border-radius: 4px; min-height: 28px; box-sizing: border-box; }
  .board :global(button) { padding: 0.2rem 0.7rem; cursor: pointer; }
  .board :global(button:hover:not(:disabled)) { background: var(--hover); }
  .board :global(button:disabled) { color: var(--muted); border-style: dashed; cursor: not-allowed; }
  .board :global(button:focus-visible), .board :global(select:focus-visible), .board :global(input:focus-visible), .board :global(textarea:focus-visible), .board :global(summary:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
  .board :global(button.primary) { border-width: 2px; border-color: var(--fg); font-weight: 600; }
  .board :global(button.link) { border: none; background: none; color: var(--focus); padding: 0.2rem 0.25rem; }
  .board :global(textarea), .board :global(input[type='text']) { width: 100%; padding: 0.35rem 0.5rem; }
  .board :global(select) { padding: 0.15rem 0.3rem; max-width: 100%; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.4rem 0; align-items: center; }
  .grow { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--muted); border-radius: 4px; overflow: hidden; }
  .board .seg :global(button) { border: 0; border-radius: 0; }
  .board .seg :global(button[aria-pressed='true']) { background: var(--fg); color: var(--bg); font-weight: 600; }
  .board :global(.section-head) { margin: 0.8rem 0 0.2rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 0.15rem; }
  .board :global(.rows) { list-style: none; margin: 0; padding: 0; }
  .board :global(.row) { display: grid; grid-template-columns: 6rem minmax(0, 1fr) 11rem 7rem; gap: 0.1rem 0.8rem; padding: 0.4rem 0.5rem; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; width: 100%; text-align: left; min-height: 44px; align-items: start; line-height: 1.35; }
  .board :global(.row:hover) { background: var(--hover); }
  .board :global(.row .sev) { font-weight: 700; }
  .board :global(.row .sev small), .board :global(.row .sev .small) { display: block; font-weight: 400; }
  .board :global(.sev.red) { color: var(--error); }
  .board :global(.sev.amber) { color: var(--warning); }
  .board :global(.sev.grey), .board :global(.sev.low) { color: var(--muted); }
  .board :global(.row .main) { min-width: 0; }
  .board :global(.row .title) { font-weight: 600; }
  .board :global(.row .verb), .board :global(.row .changed), .board :global(.row .due) { display: block; }
  .board :global(.row .verb::before) { content: '\2192\00a0'; }
  .board :global(.row .changed), .board :global(.row .due) { color: var(--muted); font-size: 0.85rem; font-weight: 400; }
  .board :global(.row .status) { font-weight: 600; }
  .board :global(.row.grey) { color: var(--muted); }
  .board :global(.greyask) { margin: 0.2rem 0.5rem 0.4rem 6.8rem; font-size: 0.9rem; }
  .board :global(.chip) { display: inline-block; border: 1px solid var(--muted); border-radius: 999px; padding: 0 0.55rem; min-height: 24px; line-height: 22px; font-size: 0.82rem; font-weight: 600; white-space: nowrap; }
  .board :global(.chip.none) { border-style: dashed; }
  .board :global(.tag) { display: inline-block; border: 1px solid currentColor; border-radius: 3px; padding: 0 0.35rem; margin-left: 0.3rem; font-size: 0.75rem; font-weight: 700; line-height: 1.3; white-space: nowrap; }
  .board :global(details.below) { margin-top: 1rem; border-top: 2px solid var(--fg); }
  .board :global(details > summary) { cursor: pointer; padding: 0.4rem 0.3rem; min-height: 28px; display: list-item; }
  .board :global(details.below > summary) { font-weight: 700; }
  .board :global(.notes) { list-style: none; padding: 0; margin: 0; }
  .board :global(.notes li) { padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  .board :global(.field) { margin: 0.7rem 0; }
  .board :global(.field > label), .board :global(.field > .lab) { display: block; font-weight: 600; margin-bottom: 0.2rem; }
  .board :global(fieldset) { border: 0; padding: 0; margin: 0; }
  .board :global(.radio) { display: flex; align-items: center; gap: 0.5rem; min-height: 28px; }
  .board :global(.radio input) { width: 24px; height: 24px; }
  .board :global(.hdr) { display: flex; flex-wrap: wrap; gap: 0.4rem 0.7rem; align-items: center; margin: 0.3rem 0 0.6rem; }
  .board :global(.hdr .mech) { font-weight: 700; }
  .board :global(.hdr-rate) { flex-basis: 100%; }
  .board :global(.cols) { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 0 1.5rem; }
  @media (max-width: 860px) { .board :global(.cols) { grid-template-columns: 1fr; } .board :global(.row) { grid-template-columns: 4.6rem 1fr; } }
  .board :global(.panel) { border: 1px solid var(--border); border-radius: 6px; padding: 0.1rem 0.9rem 0.8rem; margin: 0.8rem 0; }
  .board :global(table) { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  .board :global(th), .board :global(td) { text-align: left; padding: 0.3rem 0.5rem 0.3rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  .board :global(ol.causes) { padding-left: 1.3rem; }
  .board :global(ol.causes li) { margin: 0.5rem 0; }
  .board :global(.look) { display: block; color: var(--muted); font-size: 0.88rem; }
  .board :global(.ruled .cause) { text-decoration: line-through; }
  .board :global(.titlerow) { display: flex; flex-wrap: wrap; gap: 0.3rem 0.9rem; align-items: center; }
  .board :global(.titlerow h3) { margin: 0.3rem 0 0.2rem; }
  .board :global(.readback) { list-style: none; padding: 0 0.5rem 0.4rem 6.8rem; border-bottom: 1px solid var(--border); }
  .board :global(.causeline) { margin: 0.2rem 0; }
  .board :global(.crumbs) { margin: 0.5rem 0; }
  .board :global(.bigcard) { border: 2px solid var(--fg); border-radius: 6px; padding: 0.6rem 0.9rem; margin: 0.8rem 0; }
  .board :global(.flash) { border: 2px solid var(--fg); border-radius: 6px; padding: 0.5rem 0.8rem; font-weight: 600; }
  .board :global(.verdict) { display: inline-block; border: 3px solid var(--warning); color: var(--warning); border-radius: 6px; padding: 0.3rem 0.9rem; font-size: 1.35rem; font-weight: 800; }
  .board :global(.verdict.hold) { border-color: var(--error); color: var(--error); border-style: double; }
  .board :global(ol.queue) { list-style: none; counter-reset: q; padding: 0; }
  .board :global(ol.queue li) { counter-increment: q; display: grid; grid-template-columns: 2rem 2rem 1fr; gap: 0.5rem; padding: 0.6rem 0; border-bottom: 1px solid var(--border); }
  .board :global(ol.queue li::before) { content: counter(q) '.'; font-weight: 800; }
  .board :global(ol.queue input[type='checkbox']) { width: 26px; height: 26px; margin: 2px 0 0; }
  .board :global(ol.queue .what), .board :global(ol.queue .small) { display: block; }
  .board :global(ol.queue .what) { font-weight: 700; }
  .board :global(.printbox) { font-size: 1.4rem; line-height: 1; }
</style>
