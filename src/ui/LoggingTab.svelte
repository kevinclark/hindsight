<!--
  The Logging tab for one match: a to-do list of the signals the checks need that this log lacks (or logs too slowly),
  each with the checks that went dark without it and what those checks exist to catch; then the wanted checks; then
  what is logged, folded away. It says what to log and under which key, never how: the robot code is the students'.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { coverage, type CoverageLine } from '../coverage/coverage.ts'
  import { STATE_ICON, STATE_WORDS } from '../coverage/words.ts'
  import { WANTED_CHECKS } from '../rules/wanted.ts'

  let { analysis }: { analysis: Analysis } = $props()

  const cov = $derived(coverage(analysis.match, analysis.report))
  const todo = $derived(cov.lines.filter((l) => l.state !== 'logged'))
  const logged = $derived(cov.lines.filter((l) => l.state === 'logged'))
  const count = (state: CoverageLine['state']) => cov.lines.filter((l) => l.state === state).length
  const hz = (l: CoverageLine) => (l.measuredHz ? `${Math.round(l.measuredHz)} Hz` : '')
</script>

<p class="counts">
  {cov.lines.length} signals the checks need: {count('logged')} logged ·
  <span class:w={count('slow') > 0}>{count('slow')} slow</span> · <span class:w={count('never changes') > 0}>{count('never changes')} never change</span> ·
  <span class:e={count('not logged') > 0}>{count('not logged')} not logged</span> · {count('profile gap')} with no key in the robot profile
</p>
{#if cov.misfit}<p class="warn">{cov.misfit}</p>{/if}
{#if cov.hoot}<p class={`hoot ${cov.hoot.state}`}>{cov.hoot.text}</p>{/if}

<section>
  <h3>To do ({todo.length})</h3>
  {#if todo.length === 0}
    <p>Every signal the checks need is in this log, often enough.</p>
  {:else}
    <p class="hint">Signals behind the checks that guard the match come first. Each says what to log and under which key; how is up to you.</p>
    <ul class="lines">
      {#each todo as l (l.key ?? l.what)}
        <li class={l.state.replace(/ /g, '-')}>
          <p class="head">
            <span class="icon" aria-hidden="true">{STATE_ICON[l.state]}</span>
            <strong>{l.what}</strong>{#if l.key}{' '}<code>{l.key}</code>{/if}
            <span class="state">{STATE_WORDS[l.state]}{hz(l) ? `, ${hz(l)}` : ''}</span>
          </p>
          <p class="todo">{l.todo}</p>
          {#if l.dark.length}
            <p class="sub">Checks that go dark without it:</p>
            <ul class="dark">
              {#each l.dark as d (d.rule)}
                <li><span class={d.severity}>{d.title}</span> <code>{d.rule}</code>{d.partly ? ' (partly)' : ''}{#if d.incident}<span class="incident"> · catches: {d.incident}</span>{/if}</li>
              {/each}
            </ul>
          {:else if l.state === 'not logged'}
            <p class="sub">No check said it was missing in this log. A check stops at the first signal it misses, so one may still need this.</p>
          {:else}
            <p class="sub">No check said so in this log.</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section>
  <h3>Wanted checks ({WANTED_CHECKS.length})</h3>
  <p class="hint">Problems that have happened that no check can catch yet, because the robot doesn't log what it would take. Each becomes a check once the signal is in a log.</p>
  <ul class="lines">
    {#each WANTED_CHECKS as w (w.id)}
      <li class="wanted">
        <p class="head"><span class="icon" aria-hidden="true">⬜</span> <strong>{w.question}</strong> <span class="state">{w.liveOnly ? 'only a live check can see this' : 'not covered'}</span></p>
        <p class="todo">What happened: {w.incident}.</p>
        {#if w.liveOnly}
          <p class="sub">Not a gap in this log: {w.liveOnly}.</p>
          {#if w.coveredBy}<p class="sub">Foresight checks it on a robot with the Hindsight companion library (<code>{w.coveredBy}</code>).</p>{/if}
        {:else}
          <p class="sub">The robot would need to log {w.needs}.</p>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<details>
  <summary><h3>Logged ({logged.length})</h3></summary>
  <table>
    <tbody>
      {#each logged as l (l.key)}
        <tr><td aria-hidden="true">✅</td><th scope="row">{l.what}</th><td><code>{l.found ?? l.key}</code></td><td class="num">{hz(l)}</td></tr>
      {/each}
    </tbody>
  </table>
</details>

<style>
  .counts { color: var(--muted); margin: 0 0 0.5rem; }
  .e { color: var(--error); font-weight: 600; }
  .w { color: var(--warning); font-weight: 600; }
  .warn { color: var(--warning); font-size: 0.85rem; }
  .hoot { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.5rem; }
  section, details { margin-top: 1.25rem; }
  h3 { font-size: 1rem; margin: 0 0 0.25rem; }
  details summary { cursor: pointer; min-height: 24px; }
  details h3 { display: inline; }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.5rem; }
  .lines { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
  .lines > li { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
  .lines p { margin: 0; }
  .head { overflow-wrap: anywhere; }
  .icon { display: inline-block; width: 1.4em; }
  .state { color: var(--muted); font-size: 0.85rem; }
  .not-logged .state { color: var(--error); }
  .slow .state, .never-changes .state { color: var(--warning); }
  .todo, .sub, .dark { margin-left: 1.4em !important; }
  .todo { font-size: 0.9rem; }
  .sub { color: var(--muted); font-size: 0.85rem; }
  .dark { padding-left: 1.1rem; font-size: 0.85rem; }
  .dark .error { color: var(--error); }
  .dark .warning { color: var(--warning); }
  .incident { color: var(--muted); }
  table { border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem; }
  th { text-align: left; font-weight: normal; padding: 0.15rem 1rem 0.15rem 0.25rem; }
  td { color: var(--muted); overflow-wrap: anywhere; padding: 0.15rem 0.5rem 0.15rem 0; }
  .num { text-align: right; white-space: nowrap; }
</style>
