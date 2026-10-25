<!--
  "Next match: not known yet" with the two ways to fix it, in place (ADR b): type the next match number, or add the team's
  The Blue Alliance read key (it names the event and the schedule). The team number is asked only when none is set.
  Needs nothing from the board view, so the board and the Now screen mount the same component: it takes the session (to file
  the typed number under the event, as the board files its notes) and works out the rest.
  The typed number is kept on this laptop only (src/board/typed-next.ts) and goes to the timeline as its own input.
  The key is never shown back: the field empties on Save and the saved key is only reported as "saved".
-->
<script lang="ts">
  import type { Session } from '../session/session.ts'
  import { activeTyped, lastOnField, qualOf, staleWhy } from '../board/points.ts'
  import { parseNext } from '../board/typed-next.ts'
  import { saveSetup, tbaHasKey, tbaTeam } from './tba-setting.svelte.ts'
  import { saveTypedNext, typedNextFor } from './typed-next.svelte.ts'

  let { session, scheduleNote = null, idPrefix = 'next' }: {
    session: Pick<Session, 'event' | 'matches' | 'label'>
    /** Why the schedule could not be read, when it was asked for ("No schedule: offline, no saved copy"). */
    scheduleNote?: string | null
    /** Two copies on a page need different ids for their labels. */
    idPrefix?: string
  } = $props()

  const saved = $derived(typedNextFor(session))
  const lastQual = $derived.by(() => { const m = lastOnField({ matches: session.matches } as Session); return m ? qualOf(m.matchLabel) : null })
  // One rule for "does the typed number still mean something" (src/board/points.ts), the same one the timeline uses.
  const active = $derived(activeTyped({ matches: session.matches }, saved) !== null)
  const why = $derived(staleWhy({ matches: session.matches }, saved))
  /** With a number active the fields fold to one line; these open the forms again. */
  let changing = $state(false)
  let keying = $state(false)

  let typed = $state('')
  let keyText = $state('')
  let teamText = $state('')
  let problem = $state<string | null>(null)
  let busy = $state(false)

  function saveNumber(e: Event) {
    e.preventDefault()
    const n = parseNext(typed)
    if (n === null) { problem = 'Type the match number, like 41 or Q41.'; return }
    if (activeTyped({ matches: session.matches }, n) === null) {
      problem = staleWhy({ matches: session.matches }, n) === 'playoffs' ? 'Playoffs have started: a qualification is not next.' : `Q${lastQual} is already played; type a later match.`
      return
    }
    saveTypedNext(session, typed)
    problem = null
    typed = ''
    changing = false
  }
  async function saveKey(e: Event) {
    e.preventDefault()
    const team = tbaTeam() === null ? (/^\s*\d{1,5}\s*$/.test(teamText) ? Number(teamText) : null) : undefined
    if (tbaTeam() === null && (team === null || team === 0)) { problem = 'Type your team number too: the schedule is the team\'s.'; return }
    if (!keyText.trim() && team === undefined) { problem = 'Paste the key first.'; return }
    busy = true
    problem = await saveSetup({ ...(team !== undefined ? { team } : {}), key: keyText })
    busy = false
    keyText = ''
    if (problem === null) teamText = ''
  }
</script>

<div class="next-fields" data-next-match-fields>
  {#if active && !changing && !keying}
    <p class="line">
      <strong>Next match: Q{saved}</strong>
      <span class="muted">· typed on this laptop, counts until its log is in ·</span>
      <button type="button" class="linkish" onclick={() => (changing = true)}>Change</button>
      {#if !(tbaHasKey() && tbaTeam() !== null)}<span class="muted">·</span> <button type="button" class="linkish" onclick={() => (keying = true)}>or add the read key</button>{/if}
    </p>
  {:else}
    <form class="line" onsubmit={saveNumber}>
      <strong>Next match: {active ? `Q${saved}` : 'not known yet'}</strong>
      {#if saved !== null && !active}<span class="muted">Q{saved} was typed, but {why === 'playoffs' ? 'playoffs have started' : 'its log is already in'}.</span>{/if}
      <label for="{idPrefix}-number">{active ? 'Change it' : 'Type it'}</label>
      <span class="q">Q</span><input id="{idPrefix}-number" inputmode="numeric" autocomplete="off" size="4" placeholder={saved === null ? '41' : ''} bind:value={typed} aria-describedby="{idPrefix}-problem" />
      <button type="submit">Save</button>
      {#if active}<button type="button" class="linkish" onclick={() => (changing = false)}>Cancel</button>{/if}
    </form>
  {/if}
  {#if tbaHasKey() && tbaTeam() !== null}
    {#if !active}<p class="muted">A key and team are saved{scheduleNote ? `, but ${scheduleNote.replace(/^No schedule:\s*/, '')}` : ', but no schedule came back for this event'}. Type the match until it does.</p>{/if}
  {:else if !active || keying}
    <form class="line" onsubmit={saveKey}>
      <span class="or">or add your team's The Blue Alliance read key (it names the event and the schedule):</span>
      {#if tbaTeam() === null}
        <label for="{idPrefix}-team">Team number</label>
        <input id="{idPrefix}-team" inputmode="numeric" autocomplete="off" size="6" bind:value={teamText} />
      {/if}
      <label for="{idPrefix}-key">Read key</label>
      <input id="{idPrefix}-key" type="password" autocomplete="off" size="22" placeholder={tbaHasKey() ? 'saved: type to replace' : 'paste the key'} bind:value={keyText} />
      <button type="submit" disabled={busy}>Save</button>
      {#if active}<button type="button" class="linkish" onclick={() => (keying = false)}>Cancel</button>{/if}
    </form>
  {/if}
  <p id="{idPrefix}-problem" class="problem" role="alert">{problem ?? ''}</p>
</div>

<style>
  .next-fields { border: 1px solid var(--border); border-radius: 8px; padding: 0.3rem 0.9rem; margin: 0.5rem 0; }
  .muted { color: var(--muted); }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.6rem; margin: 0.3rem 0; }
  .or { color: var(--muted); }
  input { width: auto; min-height: 28px; box-sizing: border-box; padding: 0.2rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; max-width: 100%; }
  button { min-height: 28px; min-width: 28px; padding: 0.2rem 0.9rem; border: 1px solid var(--focus); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  button:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
  .next-fields .line input { width: 6rem; }
  .next-fields .line input[type='password'] { width: 15rem; }
  .linkish { min-width: 24px; border: none; background: none; color: var(--fg); text-decoration: underline; padding: 0.2rem 0.3rem; }
  ::placeholder { color: var(--muted); opacity: 1; }
  .q { margin-right: -0.4rem; }
  .problem { color: var(--error); margin: 0.2rem 0 0; min-height: 0; }
  .problem:empty { display: none; }
</style>
