<!--
  Foresight's queue checklist (ADR 9, event mode): do-confirm. The robot's systems, numbered, most critical first, each Go,
  Go with deferral (the issue and its workaround line named) or No-go; a tick with a role and a time confirms each one
  done, for 90 minutes. The overall word is above, in Foresight's verdict box. Colour only where something needs a look:
  No-go, Not checked and deferral rows; Go rows are plain grey. Shape and a word go with every state, never colour alone
  (WCAG 1.4.1). Each row says how many of its checks ran, so a Go never hides a gap.
-->
<script lang="ts">
  import type { QueueChecklist, QueueRow, System, Tick } from '../foresight/checklists.ts'
  import { ROLES } from '../board/role.ts'
  import { clockText } from '../board/words.ts'
  import type { BoardRole } from '../triage/history.ts'

  let { checklist, changed = null, role, ticks, forLabel, filed, onTick, onRole }: {
    checklist: QueueChecklist; /** The files between the last match's commit and the robot's, when the code folder could read both (or why not). */ changed?: { files: string[] } | { problem: string } | null; role: BoardRole | null; ticks: ReadonlyMap<System, Tick>; forLabel: string
    /** True when ticks are filed in the history (today's event session is loaded); false: kept on this page only. */
    filed: boolean
    onTick: (system: System, on: boolean) => void; onRole: (role: BoardRole | null) => void
  } = $props()

  const MARK: Record<QueueRow['word'], string> = { 'No-go': '●', 'Not checked': '○', 'Check by hand': '☞', 'Go with deferral': '▲', Go: '✓' }
  const CLASS: Record<QueueRow['word'], string> = { 'No-go': 'nogo', 'Not checked': 'unknown', 'Check by hand': 'unknown', 'Go with deferral': 'defer', Go: 'go' }
  /** Only a system that can be confirmed done takes a tick: a No-go or unjudged one is fixed or checked first. */
  const canTick = (r: QueueRow) => !!role && (r.word === 'Go' || r.word === 'Go with deferral' || r.word === 'Check by hand')
  /** A tick counts only while it is fresh, and only on a row that can be confirmed. */
  const freshTick = (r: QueueRow): Tick | undefined => { const t = ticks.get(r.system); return t && !t.old && (r.word === 'Go' || r.word === 'Go with deferral') ? t : undefined }
  const oldTick = (r: QueueRow): Tick | undefined => { const t = ticks.get(r.system); return t?.old ? t : undefined }
  // Deferrals with no row of their own (none today: every one is on its system's row) keep a list.
  const unshown = $derived(checklist.deferrals.filter((d) => !checklist.rows.some((r) => r.deferrals.some((x) => x.key === d.key))))
</script>

<section class="queue" aria-label="Queue checklist">
  <h3>Queue checklist <span class="muted">· {checklist.rows.length} systems, most critical first</span></h3>
  {#if checklist.freeze}<p class="small freeze" data-freeze>{checklist.freeze.banner}</p>{/if}
  <p class="small">Do each item, then tick it for {forLabel}. A No-go is fixed or deferred on the board first. {filed ? 'Ticks are filed with the event.' : 'Ticks stay on this page.'}
    <label>You are on: <select aria-label="Your role" value={role ?? ''} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; onRole(ROLES.includes(v as BoardRole) ? (v as BoardRole) : null) }}>
      {#if !role}<option value="" disabled>choose…</option>{/if}
      {#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
    </select></label>{#if !role}{' '}Choose it to tick.{/if}</p>
  {#if checklist.freeze}
    {#if checklist.freeze.change}
      {@const c = checklist.freeze.change}
      {#if c.amber}<p class="change amber" data-code-change><b>Flag:</b>{' '}{c.text}{#if c.kind === 'changed' && !changed}{' '}<span class="muted">Choose the robot-code folder below to see which files changed.</span>{/if}</p>
      {:else}<p class="change same" data-code-change><span aria-hidden="true">✓</span>{' '}{c.text}</p>{/if}
      {#if c.kind === 'changed' && changed}
        {#if 'files' in changed}
          <details class="changed-files"><summary>{changed.files.length} {changed.files.length === 1 ? 'file' : 'files'} changed between them</summary>
            <ul>{#each changed.files.slice(0, 40) as f (f)}<li><code>{f}</code></li>{/each}</ul>
            {#if changed.files.length > 40}<p class="small">and {changed.files.length - 40} more.</p>{/if}
          </details>
        {:else}<p class="small">The files changed could not be read: {changed.problem}</p>{/if}
      {/if}
    {/if}
  {/if}
  <ol class="systems">
    {#each checklist.rows as r, n (r.system)}
      {@const tick = freshTick(r)}
      {@const old = oldTick(r)}
      <li class={`sys ${CLASS[r.word]}`}>
        <input type="checkbox" checked={!!tick} disabled={!canTick(r) && !tick} aria-label={`Done: ${r.system}`} onchange={(e) => onTick(r.system, (e.currentTarget as HTMLInputElement).checked)} />
        <div>
          <p class="head"><span class="num">{n + 1}.</span> <span class="mark" aria-hidden="true">{MARK[r.word]}</span> <span class="name">{r.system}</span> <span class="word">{r.word}</span> <span class="ran">{r.ran.n} of {r.ran.of} checks ran{r.note ? ` · ${r.note}` : ''}</span></p>
          {#if r.word === 'No-go'}
            {#each r.fix as i (i.finding.key + i.finding.title)}
              <p class="line">{i.finding.title}<br /><b>Do:</b> {i.action}</p>
              <p class="line muted">{i.finding.rule} · {i.proof}</p>
              <details class="why"><summary>Evidence</summary>
                <p>{i.finding.meaning}</p>
                <dl>{#each Object.entries(i.finding.evidence) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
                <p>Could be: {i.finding.causes.map((c) => `${c.cause} (${c.look})`).join('; ')}</p>
              </details>
            {/each}
          {/if}
          {#if r.word === 'Check by hand'}<p class="line"><b>{r.step ?? 'None of its checks ran: a person checks it.'}</b> Tick when done.</p>{/if}
          {#if r.word === 'Not checked'}<p class="line muted">{r.text.replace(/^Not checked:? ?/, '') || 'No current check.'}</p>{/if}
          {#each r.deferrals as d (d.key)}
            <p class="line">{d.title} · <b>workaround:</b> {d.workaround || 'none written'} <span class="muted">· until {d.until} · {d.seenNow ? 'seen now' : 'not seen now'}{d.carriedFrom ? ` · carried from ${d.carriedFrom}` : ''}</span></p>
          {/each}
          {#if r.look.length}<p class="line muted">{r.look.length} to look at: {r.look.map((i) => i.finding.title).join('; ')}</p>{/if}
          {#if tick}<p class="line"><b>Done, ticked by {tick.role} at {clockText(tick.when)}</b></p>{/if}
          {#if old}<p class="line muted">ticked at {clockText(old.when)} ({old.ahead ? 'clock ahead' : 'old'})</p>{/if}
        </div>
      </li>
    {/each}
  </ol>
  {#if unshown.length}
    <h4>Open deferrals without a row ({unshown.length})</h4>
    <ul class="defers">
      {#each unshown as d (d.key)}<li>{d.title} <span class="muted">· {d.system}</span><br /><b>Workaround:</b> {d.workaround || 'none written'} <span class="muted">· until {d.until}</span></li>{/each}
    </ul>
  {:else}
    <p class="small">Open deferrals for this robot: {checklist.deferrals.length ? `${checklist.deferrals.length}, each on its row above` : 'none'}.</p>
  {/if}
  {#if checklist.deferralNote}<p class="small">{checklist.deferralNote}</p>{/if}
</section>

<style>
  .queue { margin-top: 0.75rem; }
  h3 { font-size: 1rem; margin: 0 0 0.2rem; }
  h4 { font-size: 0.95rem; margin: 1rem 0 0.3rem; }
  .muted { color: var(--muted); font-weight: 400; }
  .small { font-size: 0.8rem; color: var(--muted); margin: 0.2rem 0; }
  .small select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; min-height: 24px; box-sizing: border-box; }
  .freeze { margin: 0; }
  .change.same { color: var(--muted); font-weight: 400; }
  .change { margin: 0.3rem 0; padding: 0.3rem 0.6rem; }
  .change.amber { border-left: 4px solid var(--warning); }
  .changed-files { font-size: 0.85rem; margin: 0 0 0.4rem 0.6rem; }
  .changed-files summary { cursor: pointer; min-height: 24px; box-sizing: border-box; color: var(--muted); }
  .changed-files ul { margin: 0.2rem 0; padding-left: 1.2rem; }
  .systems { list-style: none; margin: 0; padding: 0; }
  .sys { display: grid; grid-template-columns: 1.6rem 1fr; gap: 0.5rem; padding: 0.35rem 0.6rem; border-left: 4px solid var(--border); border-bottom: 1px solid var(--border); align-items: start; }
  .sys input { width: 1.5rem; height: 1.5rem; margin: 0; }
  .sys.nogo { border-left-color: var(--error); }
  .sys.defer { border-left-color: var(--warning); }
  .sys.unknown { border-left-color: var(--focus); border-left-style: dashed; }
  p { margin: 0; }
  .head { font-size: 1.05rem; }
  .num { color: var(--muted); font-size: 0.85rem; display: inline-block; min-width: 1.1rem; }
  .name { font-weight: 700; }
  .word { font-weight: 700; margin-left: 0.4rem; }
  .ran { margin-left: 0.6rem; font-size: 0.8rem; color: var(--muted); }
  .go .word, .go .mark { color: var(--muted); }
  .nogo .word, .nogo .mark { color: var(--error); }
  .defer .word, .defer .mark { color: var(--warning); }
  .unknown .word, .unknown .mark { color: var(--focus); }
  .line { margin-top: 0.2rem; font-size: 0.9rem; overflow-wrap: anywhere; }
  .why { font-size: 0.85rem; margin-top: 0.2rem; }
  .why summary { color: var(--muted); cursor: pointer; min-height: 24px; box-sizing: border-box; }
  .why dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.1rem 0.75rem; margin: 0.3rem 0; }
  .why dt { color: var(--muted); }
  .why dd { margin: 0; overflow-wrap: anywhere; }
  .defers { list-style: none; margin: 0; padding: 0; font-size: 0.9rem; }
  .defers li { padding: 0.3rem 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
</style>
