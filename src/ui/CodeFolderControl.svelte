<!--
  "Choose code folder": the robot-code folder (a git clone), so a log that ran another commit than its robot profile's
  can be checked for the same current limits (power/limit-not-applied). Shared by Match review and the Session view.
-->
<script lang="ts">
  import { codeFolder } from './code-folder.svelte.ts'
</script>

<span class="code-folder">
  <!-- Where the browser has a folder picker it can remember (Chrome, Edge), the click opens that instead of the input. -->
  <label class="button">
    {codeFolder.chosen ? 'Change code folder…' : 'Choose code folder…'}
    <input type="file" webkitdirectory multiple data-code-folder aria-label="Robot code folder, for comparing current limits"
      onclick={(e) => { if (codeFolder.remembers) { e.preventDefault(); codeFolder.choose() } }} onchange={(e) => { const input = e.currentTarget as HTMLInputElement; codeFolder.fromFiles(input.files); input.value = '' }} />
  </label>
  {#if codeFolder.waiting}
    <button class="button" onclick={() => codeFolder.allow()}>Use {codeFolder.waiting.name} again</button>
  {/if}
  {#if codeFolder.chosen}
    <span class="chip" title="Its .git is read to compare current-limit lines between commits; nothing is changed or uploaded">code: {codeFolder.chosen.name}</span>
    <button class="link" onclick={() => codeFolder.forget()}>Forget</button>
  {/if}
</span>
{#if codeFolder.problem}<p class="problem" role="alert">{codeFolder.problem}</p>{/if}

<style>
  .code-folder { display: inline-flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .button { display: inline-block; min-height: 24px; box-sizing: border-box; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within, .button:focus-visible { outline: 2px solid var(--focus); }
  .chip { padding: 0.15rem 0.5rem; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 0.85em; }
  .link { min-height: 24px; padding: 0.2rem 0.4rem; border: none; background: none; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; }
  .problem { color: var(--error); }
</style>
