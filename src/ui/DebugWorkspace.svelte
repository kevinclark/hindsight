<!--
  The debug workspace (ADR 3: debug is not a mode; it is opened from a board issue or a finding). For one finding: what it
  means, then its possible causes in Hindsight's order, each with what to look at and a state the team records (possible,
  ruled out by a test with what it showed, confirmed). The words are "possible", never "likely": no backtest supports a ranking.
  A test switch shows the causes in reverse order (off by default, named here while it is on).
-->
<script lang="ts">
  import type { Cause } from '../rules/rule.ts'
  import { debugCauses, rankNote, readReverse, writeReverse, type CauseMarks } from '../board/debug.ts'
  import { causeChange, type Change } from '../board/writes.ts'
  import { ROLES } from '../board/role.ts'
  import type { BoardRole, CauseState } from '../triage/history.ts'
  import DebugCauseCard from './DebugCauseCard.svelte'

  let { title, rule, meaning, latest, causes, likely = [], ruledOut = {}, evidence = {}, nextStep, marks, role, backLabel, onBack, onChange, onRole }: {
    title: string
    /** The rule's id, shown beside the title. */
    rule: string
    meaning: string
    /** What Hindsight said in this log. */
    latest: string
    causes: readonly Cause[]
    /** This log's ranking: the cause ids it points to and the ones it rules out (the rule's own, Hindsight's). */
    likely?: readonly string[]
    ruledOut?: Record<string, string>
    evidence?: Record<string, number | string | undefined>
    nextStep: string
    /** What the team recorded per cause (the folded board state). */
    marks: CauseMarks
    role: BoardRole | null
    backLabel: string
    onBack: () => void
    onChange: (changes: Change[]) => void
    /** Match review has no role chooser of its own: the workspace offers one. */
    onRole?: (role: BoardRole) => void
  } = $props()

  const store = (): Storage | null => { try { return localStorage } catch { return null } }
  let reverse = $state((() => { const s = store(); return s ? readReverse(s) : false })())
  function setReverse(on: boolean) { reverse = on; const s = store(); if (s) writeReverse(s, on) }

  const list = $derived(debugCauses(causes, { likely: [...likely], ruledOut }, marks, reverse))
  const evid = $derived(Object.entries(evidence).filter(([, v]) => v !== undefined))
  const note = $derived(rankNote(list.filter((c) => c.points).length))
  const counts = $derived({ out: list.filter((c) => c.state === 'ruled-out').length, ok: list.filter((c) => c.state === 'confirmed').length })
  const save = (id: string, state: CauseState, text: string, test: string) => onChange(causeChange(id, state, text, test))
</script>

<div class="dbg" data-debug>
  <p class="crumbs"><button type="button" class="link" onclick={onBack}>← {backLabel}</button></p>
  <h3 class="screen">Debug: {title}</h3>
  <p class="small muted"><code>{rule}</code></p>
  {#if reverse}<p class="testflag" role="status"><b>Test setting on:</b> the causes below are in reverse order, not Hindsight's ranking. Switch it off under "Test setting" at the bottom.</p>{/if}
  {#if onRole}
    <p class="small muted"><label>You are on: <select aria-label="Your role" value={role ?? ''} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value as BoardRole; if (ROLES.includes(v)) onRole?.(v) }}>
      {#if !role}<option value="" disabled>choose…</option>{/if}
      {#each ROLES as r (r)}<option value={r}>{r}</option>{/each}
    </select></label>{#if !role}{' '}Choose it to record what you find.{/if}</p>
  {:else if !role}<p class="note">Choose your role on the board to record what you find.</p>{/if}

  <section class="panel">
    <h4>What it means</h4>
    <p>{meaning}</p>
    <p class="small muted">Latest: {latest}</p>
    <p><b>Next step:</b> {nextStep}</p>
  </section>

  <section class="panel">
    <h4>Possible causes ({list.length}){#if counts.out || counts.ok}{' '}<span class="small muted">· {counts.out} ruled out · {counts.ok} confirmed</span>{/if}</h4>
    {#if list.length}
      <p class="hint" data-rank>{note}</p>
      <ol class="cards">{#each list as c, n (c.id)}<DebugCauseCard cause={c} n={n + 1} {role} onSave={(s, t, k) => save(c.id, s, t, k)} />{/each}</ol>
    {:else}<p class="muted">This rule lists no causes.</p>{/if}
  </section>

  {#if evid.length}
    <details class="panel"><summary>Evidence Hindsight measured ({evid.length})</summary>
      <table><tbody>{#each evid as [k, v] (k)}<tr><th scope="row">{k}</th><td>{v}</td></tr>{/each}</tbody></table>
    </details>
  {/if}

  <details class="panel testsw">
    <summary>Test setting</summary>
    <label class="radio"><input type="checkbox" checked={reverse} onchange={(e) => setReverse((e.currentTarget as HTMLInputElement).checked)} />Show the causes in reverse order</label>
    <p class="small muted">For the student test: does what people conclude follow the order, or the evidence? Off by default, kept on this laptop, and named at the top of the screen while it is on.</p>
  </details>
</div>

<style>
  .dbg { margin-top: 0.5rem; }
  .dbg :global(.muted) { color: var(--muted); }
  .small { font-size: 0.85rem; }
  .hint, .note { color: var(--muted); font-size: 0.88rem; max-width: 80ch; margin: 0.2rem 0; }
  h3.screen { font-size: 1.25rem; margin: 0.3rem 0 0.2rem; }
  h4 { font-size: 1.05rem; margin: 0.8rem 0 0.4rem; }
  .panel { border: 1px solid var(--border); border-radius: 6px; padding: 0.1rem 0.9rem 0.8rem; margin: 0.8rem 0; }
  details.panel { padding-top: 0.5rem; }
  summary { cursor: pointer; min-height: 28px; }
  summary:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .cards { padding: 0; margin: 0; }
  .testflag { border: 2px solid var(--warning); border-radius: 6px; padding: 0.4rem 0.8rem; margin: 0.4rem 0; }
  .crumbs { margin: 0.5rem 0; }
  button.link { border: none; background: none; color: var(--focus); font: inherit; padding: 0.2rem 0.25rem; cursor: pointer; }
  select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--muted); border-radius: 4px; min-height: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem 0.3rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  .radio { display: flex; align-items: center; gap: 0.5rem; min-height: 28px; }
  .radio input { width: 24px; height: 24px; margin: 0; }
</style>
