<!--
  One possible cause in the debug workspace: Hindsight's wording and what to look at, the state the team recorded (possible by
  default; ruled out by a test with what it showed; confirmed) and a form to record it. Inline fields only: window.prompt
  throws in the desktop app. A rule's own "ruled out" stays shown as Hindsight's.
-->
<script lang="ts">
  import { CAUSE_TAGS, CAUSE_WORDS, ruledOutText, type DebugCause } from '../board/debug.ts'
  import type { BoardRole, CauseState } from '../triage/history.ts'

  let { cause, n, role, onSave }: { cause: DebugCause; n: number; role: BoardRole | null; onSave: (state: CauseState, text: string, test: string) => void } = $props()

  const STATES: CauseState[] = ['possible', 'ruled-out', 'confirmed']
  let chosen = $state<CauseState>('possible')
  let test = $state('')
  let showed = $state('')
  let note = $state('')
  let problem = $state('')
  let saved = $state('')
  let open = $state(false)
  let seen = ''
  $effect(() => {
    const sig = `${cause.id}|${cause.state}|${cause.test}|${cause.text}|${cause.when}`
    if (sig === seen) return
    seen = sig
    chosen = cause.state
    test = cause.test
    showed = cause.state === 'ruled-out' ? cause.text : ''
    note = cause.state === 'ruled-out' ? '' : cause.text
    problem = ''
  })

  function save() {
    problem = ''
    if (chosen === 'ruled-out') {
      if (!test.trim() || !showed.trim()) { problem = 'Say which test you ran and what it showed. Without a test, leave it possible.'; return }
      onSave(chosen, showed.trim(), test.trim())
    } else onSave(chosen, note.trim(), '')
    saved = `Saved as ${role}.`
    open = false
  }
  const id = $derived(`cause-${cause.id}`)
</script>

<li class="card" class:ruled={cause.state === 'ruled-out'} data-cause={cause.id}>
  <div class="head">
    <span class="num">{n}.</span>
    <span class="name">{cause.cause}</span>
    {#if cause.state !== 'possible'}<span class="tag" data-state={cause.state}>{CAUSE_TAGS[cause.state]}</span>{/if}
    {#if cause.points && cause.state === 'possible'}<span class="tag">this log points to it</span>{/if}
  </div>
  <p class="look"><b>Look at:</b> {cause.look}</p>
  {#if cause.hindsightRuledOut}<p class="hind"><b>Hindsight ruled this out on this log:</b> {cause.hindsightRuledOut}</p>{/if}
  {#if cause.state === 'ruled-out'}<p class="rec">Ruled out by {ruledOutText(cause.test, cause.text) || 'a test (none written)'}{#if cause.role}{' '}<span class="chip">{cause.role}</span>{/if}</p>
  {:else if cause.state === 'confirmed'}<p class="rec">Confirmed{#if cause.text}{': '}{cause.text}{/if}{#if cause.role}{' '}<span class="chip">{cause.role}</span>{/if}</p>
  {:else if cause.text}<p class="rec">Note: {cause.text}{#if cause.role}{' '}<span class="chip">{cause.role}</span>{/if}</p>{/if}

  <details class="form" bind:open>
    <summary>Record what you found</summary>
    <fieldset class="states"><legend class="sr">State of this cause</legend>
      {#each STATES as s (s)}<label class="radio"><input type="radio" name={id} value={s} checked={chosen === s} onchange={() => (chosen = s)} />{CAUSE_WORDS[s]}</label>{/each}
    </fieldset>
    {#if chosen === 'ruled-out'}
      <div class="field"><label for={`${id}-test`}>Ruled out by (the test you ran)</label><input id={`${id}-test`} type="text" bind:value={test} placeholder="Swapped the cable with a spare" /></div>
      <div class="field"><label for={`${id}-showed`}>What it showed</label><input id={`${id}-showed`} type="text" bind:value={showed} placeholder="The drops went on, so it is not the cable" /></div>
    {:else}
      <div class="field"><label for={`${id}-note`}>Notes</label><textarea id={`${id}-note`} rows="2" bind:value={note} placeholder={chosen === 'confirmed' ? 'What confirmed it' : 'Anything you noticed'}></textarea></div>
    {/if}
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    <button type="button" class="primary" disabled={!role} onclick={save}>Save{role ? ` as ${role}` : ''}</button>
  </details>
  <span class="small" role="status">{saved}</span>
</li>

<style>
  .card { list-style: none; border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.8rem; margin: 0.6rem 0; }
  .card.ruled .name { text-decoration: line-through; }
  .head { display: flex; flex-wrap: wrap; gap: 0.3rem 0.5rem; align-items: baseline; }
  .num { font-weight: 800; }
  .name { font-weight: 700; }
  .tag { display: inline-block; border: 1px solid currentColor; border-radius: 3px; padding: 0 0.35rem; font-size: 0.75rem; font-weight: 700; line-height: 1.3; white-space: nowrap; }
  .tag[data-state='confirmed'] { color: var(--error); }
  .look, .hind, .rec { margin: 0.25rem 0; font-size: 0.92rem; }
  .look { color: var(--muted); }
  .rec { font-weight: 600; }
  .chip { display: inline-block; border: 1px solid var(--muted); border-radius: 999px; padding: 0 0.55rem; line-height: 22px; font-size: 0.82rem; font-weight: 600; }
  .form { margin-top: 0.3rem; }
  .form summary { cursor: pointer; min-height: 28px; padding: 0.2rem 0; }
  .form summary:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .states { border: 0; padding: 0; margin: 0.2rem 0; display: flex; flex-wrap: wrap; gap: 0.2rem 1.2rem; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .radio { display: flex; align-items: center; gap: 0.4rem; min-height: 28px; }
  .radio input { width: 24px; height: 24px; margin: 0; }
  .field { margin: 0.5rem 0; }
  .field label { display: block; font-weight: 600; margin-bottom: 0.15rem; }
  input[type='text'], textarea { width: 100%; box-sizing: border-box; padding: 0.35rem 0.5rem; font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--muted); border-radius: 4px; min-height: 28px; }
  button { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--muted); border-radius: 4px; min-height: 28px; padding: 0.2rem 0.7rem; cursor: pointer; }
  button.primary { border-width: 2px; border-color: var(--fg); font-weight: 600; }
  button:disabled { color: var(--muted); border-style: dashed; cursor: not-allowed; }
  .problem { color: var(--error); margin: 0.3rem 0; }
  .small { font-size: 0.85rem; color: var(--muted); }
</style>
