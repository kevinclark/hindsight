<!--
  After an update: what changed since the version last seen on this computer, until "Got it". Desktop app only (the single
  file page doesn't update itself). No card on a fresh install. The version seen is this computer's, kept with the page.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { hub } from '../hub/bridge.ts'
  import { builtChangelog, whatsNew } from '../now/changelog.ts'

  const KEY = 'hindsight.versionSeen'
  const MOST = 8

  let { hasLogs }: { hasLogs: boolean } = $props()
  let version = $state<string | null>(null)
  let lines = $state<string[]>([])

  const remember = (v: string) => { try { localStorage.setItem(KEY, v) } catch { /* private window: asked again next time */ } }

  onMount(() => {
    void hub()?.info().then(({ version: running }) => {
      let seen: string | null = null
      try { seen = localStorage.getItem(KEY) } catch { /* private window */ }
      lines = whatsNew(builtChangelog(), running, seen, hasLogs)
      version = running
      if (!lines.length) remember(running)
    }).catch(() => {})
  })
</script>

{#if version && lines.length}
  <section class="whats-new" aria-label="What's new" data-whats-new>
    <p class="head">Updated to {version}. What's new:</p>
    <ul>{#each lines.slice(0, MOST) as line (line)}<li>{line}</li>{/each}</ul>
    {#if lines.length > MOST}<p class="more">and {lines.length - MOST} more: <a href="https://github.com/kevinclark/hindsight/releases" target="_blank" rel="noreferrer">all releases</a></p>{/if}
    <button type="button" onclick={() => { remember(version!); lines = [] }}>Got it</button>
  </section>
{/if}

<style>
  .whats-new { margin: 0 0 1rem; padding: 0.6rem 0.9rem; border: 1px solid var(--focus); border-radius: 6px; }
  .head { margin: 0 0 0.3rem; font-weight: 600; }
  ul { margin: 0 0 0.5rem; padding-left: 1.2rem; }
  .more { margin: 0 0 0.5rem; }
  button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--muted); border-radius: 4px; padding: 0.25rem 0.6rem; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
