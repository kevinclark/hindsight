<!--
  What reading a .hoot needs before any file is read (ADR 13): CTRE's converter, owlet. One already on this computer
  (Hindsight's own folder, AdvantageScope's cache) is used without asking; when there is none, a button downloads it from
  CTRE's server, beside a line saying that downloading it means agreeing to CTRE's licence (CTRE's own terms: "By
  downloading, installing, accessing, or using the Software you are agreeing to be bound"). Hindsight holds no
  acceptance of its own: the agreement is between the user and CTRE. One card for the Devices tab and the Library's
  hoot-only rows. It draws nothing when nothing is needed.
-->
<script lang="ts">
  import type { HootFile } from '../hoot/types.ts'
  import CtreTerms from './CtreTerms.svelte'

  /** `files`: the .hoot files that are on this computer and would be read. `busy`: a job is running (the button waits). */
  let { files, canDownload, busy, onGetOwlet }: {
    files: HootFile[]; canDownload: boolean; busy: boolean; onGetOwlet: (compliancy: number) => void
  } = $props()
  /** Formats these files need an owlet for and this computer has none. */
  const missing = $derived([...new Set(files.filter((f) => !f.owlet && f.compliancy !== null).map((f) => f.compliancy!))])
</script>

{#each missing as c (c)}
  <div class="get">
    <p>Reading {files.filter((f) => f.compliancy === c).length === 1 ? 'this .hoot' : 'these .hoot files'} needs CTRE's converter, owlet (format {c}), and none is on this computer.</p>
    {#if canDownload}
      <p><button class="button" disabled={busy} onclick={() => onGetOwlet(c)}>Get CTRE's converter</button>{' '}About 4 MB from CTRE's own server. <CtreTerms /></p>
    {:else}
      <p>CTRE has no owlet for this kind of computer.</p>
    {/if}
  </div>
{/each}

<style>
  .get { border-left: 3px solid var(--border); padding: 0.25rem 0.75rem; max-width: 80ch; font-size: 0.9rem; }
  .button { display: inline-block; padding: 0.3rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; min-height: 24px; }
  .button:disabled { opacity: 0.5; cursor: default; }
</style>
