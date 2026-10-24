<!--
  One issue: Hindsight's text for the rule (what it means, possible causes, next step, why the rule exists, further reading), the
  sightings across matches and pit runs, notes, the rule's "not a real problem" rate, and the actions: priority, status, owner,
  defer to a named point (a workaround line is required: written for the pit crew to relay) and a note. Inline fields only:
  window.prompt throws in the desktop app.
-->
<script lang="ts">
  import { makerOf } from '../rules/index.ts'
  import type { Board, BoardIssue, Priority, RuleRate } from '../board/model.ts'
  import { PRIORITY_ICON, PRIORITY_WORDS, STATUS_WORDS } from '../board/model.ts'
  // The board's own words for a log's severity (an error is a Red, a warning an Amber), so the detail does not say "error" where the board says "Red".
  const SEVERITY_WORD = { error: 'Red', warning: 'Amber', info: 'Info' } as const
  import { OWNER_ROLES } from '../board/role.ts'
  import { suggestions } from '../board/points.ts'
  import { changedLine, clockText, dueLine, ownerText, priorityIcon, priorityWord, rowTitle, statusLine, tags } from '../board/words.ts'
  import type { Change } from '../board/writes.ts'
  import type { BoardRole } from '../triage/history.ts'

  let { issue, board, rate, role, onBack, onChange }: { issue: BoardIssue; board: Board; rate: RuleRate | undefined; role: BoardRole | null; onBack: () => void; onChange: (changes: Change[], note?: string) => void } = $props()

  const maker = $derived(makerOf(issue.rule))
  const options = $derived(suggestions(board.tl))
  const evidence = $derived(Object.entries(issue.latest?.evidence ?? {}))
  const causes = $derived.by(() => {
    const all = maker?.causes ?? []
    const likely = new Set(issue.latest?.likely ?? [])
    // The ones this log points to first, then Hindsight's own order. "Possible", never "likely": no backtest supports a ranking.
    return [...all].sort((a, b) => Number(likely.has(b.id)) - Number(likely.has(a.id)))
      .map((c) => ({ ...c, points: likely.has(c.id), ruled: issue.latest?.ruledOut?.[c.id] }))
  })

  // The form starts from what the board holds now.
  let priority = $state<Priority>('red')
  let status = $state<'open' | 'fixing' | 'check'>('open')
  let owner = $state('')
  let deferTo = $state('')
  let workaround = $state('')
  let note = $state('')
  let problem = $state('')
  let saved = $state('')
  let seen = ''
  $effect(() => {
    const sig = `${issue.key}|${issue.priority}|${issue.asked}|${issue.owner}|${issue.deferral?.when}`
    if (sig === seen) return
    seen = sig
    priority = issue.priority
    status = issue.asked
    owner = issue.owner ?? ''
    deferTo = ''
    workaround = issue.deferral?.workaround ?? ''
  })

  function save() {
    problem = ''
    const changes: Change[] = []
    if (priority !== issue.priority) changes.push({ op: 'priority', value: priority === 'red' ? 'high' : priority === 'amber' ? 'medium' : 'low' })
    if (issue.status !== 'deferred' && status !== issue.asked) changes.push({ op: 'status', value: status })
    if (owner !== (issue.owner ?? '')) changes.push({ op: 'owner', value: owner })
    if (deferTo === '__clear') changes.push({ op: 'defer', value: '' })
    else if (deferTo) {
      const pick = options.find((o) => o.id === deferTo)!
      if (!workaround.trim()) { problem = 'Write the workaround line first: the drive team reads it from the queue sheet.'; return }
      changes.push({ op: 'workaround', value: workaround.trim() }, { op: 'defer', value: pick.until.kind, until: pick.until })
    } else if (issue.status === 'deferred' && workaround.trim() !== (issue.deferral?.workaround ?? '')) {
      if (!workaround.trim()) { problem = 'A deferral needs its workaround line.'; return }
      changes.push({ op: 'workaround', value: workaround.trim() })
    }
    if (!changes.length) { saved = 'Nothing changed.'; return }
    onChange(changes)
    saved = `Saved as ${role}.`
  }
  function addNote() {
    if (!note.trim()) return
    onChange([{ op: 'note', value: note.trim() }])
    note = ''
    saved = `Note added as ${role}.`
  }
</script>

<p class="crumbs"><button type="button" class="link" onclick={onBack}>← Board</button></p>
<div class="hdr">
  <span class={`sev ${issue.grey ? 'grey' : issue.priority}`}><span aria-hidden="true">{priorityIcon(issue)}</span>{' '}{priorityWord(issue)}</span>
  <span class="mech">{issue.mechanism}</span>
  {#each tags(issue) as t (t)}<span class="tag">{t}</span>{/each}
  <span class="chip">{statusLine(issue)}</span>
  <span class="chip" class:none={!issue.owner}>{ownerText(issue)}</span>
  <span class="muted small">{dueLine(issue)}{dueLine(issue) ? ' · ' : ''}{changedLine(issue)}</span>
  <span class="small hdr-rate">Not a real problem, for this rule: {rate?.text ?? 'no marks yet'}</span>
</div>
<h3 class="screen">{rowTitle(issue)}</h3>
<p class="muted small"><code>{issue.rule}</code> · seen in {issue.firedIn.length} match{issue.firedIn.length === 1 ? '' : 'es'}{issue.sightings.some((s) => s.kind === 'pit') ? ` and ${issue.sightings.filter((s) => s.kind === 'pit').length} pit run${issue.sightings.filter((s) => s.kind === 'pit').length === 1 ? '' : 's'}` : ''} · on {issue.robot || 'an unknown robot'}</p>

<div class="cols">
  <div>
    <section class="panel">
      <h4>What it means</h4>
      <p>{maker?.meaning ?? issue.title}</p>
      <p class="muted small">Latest: {issue.title}</p>
      {#if causes.length}
        <h5>Possible causes</h5>
        <ol class="causes">
          {#each causes as c (c.id)}
            <li class:ruled={!!c.ruled}>
              <span class="cause">{c.cause}</span> <span class="tag">{c.ruled ? 'ruled out' : 'possible'}</span>{#if c.points && !c.ruled}{' '}<span class="tag">this log points to it</span>{/if}
              <span class="look">{c.ruled ? c.ruled : `Look at: ${c.look}`}</span>
            </li>
          {/each}
        </ol>
        <p class="hint">"Possible", not "likely": no backtest supports a ranking of causes yet.</p>
      {/if}
      <h5>Next step</h5>
      <p>{issue.nextStep}</p>
      {#if evidence.length}
        <details><summary>Evidence Hindsight measured ({evidence.length})</summary>
          <table><tbody>{#each evidence as [k, v] (k)}<tr><th scope="row">{k}</th><td>{v}</td></tr>{/each}</tbody></table>
        </details>
      {/if}
      {#if maker && 'incident' in maker}<p class="small muted"><b>Why this rule exists:</b> {maker.incident}</p>{/if}
    </section>
    <section class="panel">
      <h4>Further reading</h4>
      {#if maker && 'sources' in maker && maker.sources.length}
        <ul class="sources">{#each maker.sources as s (s.url)}<li><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>{' '}<span class="muted">({s.kind})</span>: {s.says}</li>{/each}</ul>
      {:else}<p class="muted">None for this check.</p>{/if}
    </section>
    <section class="panel">
      <h4>Seen in</h4>
      <table>
        <thead><tr><th scope="col">Where</th><th scope="col">Severity</th><th scope="col">What Hindsight said</th></tr></thead>
        <tbody>
          {#each issue.sightings as s, n (n)}<tr><td><b>{s.label}</b>{s.logs > 1 ? ` (${s.logs} logs)` : ''}{s.at ? ` · ${new Date(s.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</td><td>{SEVERITY_WORD[s.severity]}</td><td>{s.title}</td></tr>{/each}
        </tbody>
      </table>
      {#if issue.sightings.some((s) => s.kind === 'pit')}<p class="hint">A pit run is a sighting, not a match: it is not counted in the match totals.</p>{/if}
    </section>
    <section class="panel">
      <h4>Notes</h4>
      {#if issue.notes.length}<ul class="notes">{#each issue.notes as n (n.when + n.text)}<li><b>{n.match ?? 'no match'}</b> · <span class="chip">{n.role}</span> {n.text}</li>{/each}</ul>{:else}<p class="muted">No notes yet.</p>{/if}
      <div class="field"><label for="board-note">Add a note</label><textarea id="board-note" rows="2" bind:value={note} placeholder="What you tried, what you saw, what you ruled out."></textarea></div>
      <button type="button" disabled={!role || !note.trim()} onclick={addNote}>Add note{role ? ` as ${role}` : ''}</button>
    </section>
  </div>
  <div>
    <section class="panel noprint">
      <h4>Actions</h4>
      {#if !role}<p class="note">Choose your role on the board to make changes.</p>{:else}<p class="hint">You are acting as <b>{role}</b>.</p>{/if}
      <fieldset class="field"><legend class="lab">Priority</legend>
        {#each ['red', 'amber', 'low'] as p (p)}<label class="radio"><input type="radio" name="board-priority" value={p} checked={priority === p} onchange={() => (priority = p as Priority)} />{PRIORITY_ICON[p as Priority]}{' '}{PRIORITY_WORDS[p as Priority]}</label>{/each}
      </fieldset>
      <div class="field"><label for="board-status">Status</label>
        <select id="board-status" bind:value={status} disabled={issue.status === 'deferred'}>
          {#if issue.status === 'deferred'}<option value={status}>Deferred (workaround until {issue.deferral?.point.until})</option>{/if}
          {#each ['open', 'fixing', 'check'] as v (v)}{#if issue.status !== 'deferred'}<option value={v}>{STATUS_WORDS[v as 'open']}</option>{/if}{/each}
        </select>
        <span class="hint">{issue.status === 'deferred' ? 'Deferred: clear the deferral to change the status.' : 'Closed happens by itself: after a clean match that follows the fix.'}</span></div>
      <div class="field"><label for="board-owner">Owner</label>
        <select id="board-owner" bind:value={owner}><option value="">No owner yet</option>{#each OWNER_ROLES as r (r)}<option value={r}>{r}</option>{/each}</select></div>
      <div class="field"><label for="board-defer">Defer to</label>
        <select id="board-defer" bind:value={deferTo}>
          <option value="">{issue.status === 'deferred' ? 'Keep the deferral' : 'Not deferred'}</option>
          {#if issue.status === 'deferred'}<option value="__clear">Clear the deferral</option>{/if}
          {#each options as o (o.id)}<option value={o.id}>{o.label} · {o.estimate}{o.suggested && issue.priority === 'red' ? ' · suggested for a red' : ''}</option>{/each}
        </select>
        <span class="hint">Each point shows its estimated time from now (after {board.tl.last?.label ?? 'the last match'}).{board.noSchedule ? ' No schedule: points are by name only.' : ''}</span></div>
      <div class="field"><label for="board-workaround">Workaround line for the drive team</label>
        <textarea id="board-workaround" rows="3" bind:value={workaround} placeholder="Written for the pit crew to pass on: what the drivers do or avoid until this is fixed."></textarea></div>
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      <button type="button" class="primary" disabled={!role} onclick={save}>Save changes</button> <span class="small" role="status">{saved}</span>
    </section>
  </div>
</div>
