<!-- The PDP 2.0 in miniature with one slot lit: a finding's "which breaker is this". A click opens the map at that slot. -->
<script lang="ts">
  import { slotRows, slotEntries, breakerFill } from '../power/power-map-view.ts'
  import type { PowerMap } from '../power/power-map.ts'

  let { map, slot, onclick }: { map: PowerMap | null; slot: number; onclick?: () => void } = $props()
  const rows = slotRows(false)
</script>

<button class="thumb" type="button" {onclick} aria-label={`Open the power map at PDP slot ${slot}`} title={`PDP slot ${slot}: open the power map`}>
  <svg viewBox="0 0 132 34" width="198" height="51" role="img" aria-hidden="true">
    {#each rows as row, r (r)}
      {#each row as n, i (n)}
        {@const e = map ? slotEntries(map, 'pdp', n)[0] : undefined}
        <rect x={2 + i * 10} y={2 + r * 15} width="8" height="12" rx="1.5" fill={e?.breaker ? breakerFill(e.breaker.ratingA) : 'none'} stroke={n === slot ? 'var(--error)' : 'var(--muted)'} stroke-width={n === slot ? 2.2 : 0.8} />
      {/each}
    {/each}
    <text x="126" y="12" font-size="9" text-anchor="middle" fill="currentColor">+</text>
    <text x="126" y="27" font-size="9" text-anchor="middle" fill="currentColor">−</text>
  </svg>
  <span class="cap">slot {slot}</span>
</button>

<style>
  .thumb { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 0.1rem; padding: 0.25rem 0.4rem; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--fg); cursor: pointer; font: inherit; }
  .thumb:hover { background: var(--hover); }
  .cap { font-size: 0.75rem; color: var(--muted); }
</style>
