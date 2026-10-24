<!--
  "Choose code folder" or "Use GitHub": the robot code (a git clone, or a public GitHub repo), so a log that ran another
  commit than its robot profile's can be checked for the same current limits (power/limit-not-applied). Shared by Match
  review and the Session view. `suggest` is the code the robot profile in view names, to pre-fill the GitHub repo;
  `linked` ("owner/repo@ref"), the code the library linked the logs in view to, wins over it. Only with neither in view
  (`suggest` undefined: no log yet) is the first built-in profile's repo offered, never another robot's for a log in view.
-->
<script lang="ts">
  import { codeFolder } from './code-folder.svelte.ts'
  import { PROFILES } from '../profiles/index.ts'
  import type { RobotProfile } from '../profiles/types.ts'

  let { suggest, linked }: { suggest?: RobotProfile['code'] | null; linked?: string } = $props()

  const REAL_REPO = /^[\w.-]+\/[\w.-]+$/
  /** The linked code; else the profile's repo and branch when it names a real repo; else, with no log in view, the first built-in profile's. */
  const suggested = $derived.by(() => {
    if (linked) return linked
    const code = [suggest, ...(suggest === undefined ? PROFILES.map((p) => p.code) : [])].find((c) => c && REAL_REPO.test(c.repo))
    return code ? `${code.repo}@${code.branch}` : ''
  })
  let asking = $state(false)
  let spec = $state('')

  function ask() {
    spec = codeFolder.github ?? suggested
    asking = !asking
  }
</script>

<span class="code-folder">
  <!-- Where the browser has a folder picker it can remember (Chrome, Edge), the click opens that instead of the input. -->
  <label class="button">
    {codeFolder.chosen && !codeFolder.github ? 'Change code folder…' : 'Choose code folder…'}
    <input type="file" webkitdirectory multiple data-code-folder aria-label="Robot code folder, for comparing current limits"
      onclick={(e) => { if (codeFolder.remembers) { e.preventDefault(); codeFolder.choose() } }} onchange={(e) => { const input = e.currentTarget as HTMLInputElement; codeFolder.fromFiles(input.files); input.value = '' }} />
  </label>
  <button class="button" aria-expanded={asking} onclick={ask}>Use GitHub…</button>
  {#if codeFolder.waiting}
    <button class="button" onclick={() => codeFolder.allow()}>Use {codeFolder.waiting.name} again</button>
  {/if}
  {#if codeFolder.chosen}
    <span class="chip" title={codeFolder.github ? 'Read from GitHub: public repos only, nothing signed in, nothing sent but the repo and commits' : 'Its .git is read to compare current-limit lines between commits; nothing is changed or uploaded'}>code: {codeFolder.github ? `${codeFolder.github} (GitHub)` : codeFolder.chosen.name}</span>
    <button class="link" onclick={() => codeFolder.forget()}>Forget</button>
  {/if}
</span>
{#if asking}
  <form class="github" onsubmit={(e) => { e.preventDefault(); if (codeFolder.useGitHub(spec)) asking = false }}
    title="Current limits are compared at the profile's pinned commit and at each log's own commit, read from this repo; the branch only names where the profile builder starts. Public repos only. GitHub allows 60 lookups an hour per network without signing in (about 1 per commit, kept for next time).">
    <label>GitHub repo and branch <input data-code-github bind:value={spec} placeholder="owner/repo@branch" size="40" spellcheck="false" autocomplete="off" /></label>
    <button class="button" type="submit">Use</button>
  </form>
{/if}
{#if codeFolder.problem}<p class="problem" role="alert">{codeFolder.problem}</p>{/if}

<style>
  .code-folder { display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .button { display: inline-block; min-height: 24px; box-sizing: border-box; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within, .button:focus-visible { outline: 2px solid var(--focus); }
  .chip { padding: 0.15rem 0.5rem; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 0.85em; }
  .link { min-height: 24px; padding: 0.2rem 0.4rem; border: none; background: none; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; }
  .github { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0.5rem 0; }
  .github input { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; max-width: 100%; }
  .problem { color: var(--error); }
</style>
