<!--
  The page's two fields for the event lookup (team number, The Blue Alliance read key), for the single-file page; the
  desktop app has them in the Library page's "Your team" box. The key stays in this browser (localStorage).
-->
<script lang="ts">
  import { savePageTba, tbaHasKey, tbaMissing, tbaTeam } from './tba-setting.svelte.ts'
  let team = $state<number | null>(tbaTeam())
  let key = $state('')
  const missing = $derived(tbaMissing())
</script>

<details class="tba" open={!!missing}>
  <summary>Event names: {missing ? 'not set up' : `team ${tbaTeam()}, key saved`}</summary>
  <p class="meta">A team number and a The Blue Alliance read key (account page, Read API Keys) name events whose logs don't, and fetch your schedule. The key stays in this browser.</p>
  <p class="row"><label>Team number <input type="number" min="1" max="99999" step="1" bind:value={team} aria-label="Team number" /></label>
    <label>Read key <input type="password" bind:value={key} autocomplete="off" placeholder={tbaHasKey() ? 'saved: type to replace' : 'paste the key'} aria-label="The Blue Alliance read key" /></label>
    <button class="button" onclick={() => { savePageTba(team ?? null, key); key = '' }}>Save</button></p>
  <p class="meta">Any page opened from disk in this browser can read this key; the desktop app keeps it private.</p>
  {#if missing}<p class="meta">{missing}</p>{/if}
</details>

<style>
  .tba { margin-bottom: 0.75rem; font-size: 0.9rem; }
  .tba summary { cursor: pointer; min-height: 24px; }
  .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
</style>
