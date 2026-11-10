<!--
  Batteries: each named battery's matches against a healthy battery at the same charge drawn (power/battery-collapse's
  number), worst battery first, so a mentor choosing batteries reads the answer before the detail (NN/g "answer first").
  One number per match, in the order played, not a score: the healthy curve is two batteries, so only the rule's line is
  a verdict. A battery is followed across events by filtering the Library to it and opening its matches here.
-->
<script lang="ts">
  import type { MatchSummary } from '../session/summary.ts'
  import { batteryTable, batteryVerdict } from '../session/batteries.ts'

  let { matches, typedBatteries, onOpen, unit = 'match' }: { matches: MatchSummary[]; typedBatteries: Record<string, string>; onOpen?: (m: MatchSummary) => void; unit?: 'match' | 'log' } = $props()

  const table = $derived(batteryTable(matches, typedBatteries))
  const units = $derived(unit === 'match' ? 'matches' : 'logs')
  const v = (x: number) => `${x.toFixed(2)} V`
  const where = (x: { volts: number | null; ah: number | null }) => (x.volts === null ? 'not measured' : `${x.volts < 0 ? `${v(-x.volts)} above` : `${v(x.volts)} below`}${x.ah !== null ? ` at ${x.ah} Ah` : ''}`)
</script>

{#if table.rows.length === 0}
  <p class="hint">No {units} here name their battery. Type each battery's label in the list below, or log the battery's name from the robot code (the profile's battery keys), to see each battery's {units} here.</p>
{:else}
  <table class="batteries">
    <thead><tr><th>Battery</th><th>Verdict</th><th>Worst</th><th>Each {unit}, in order (V below a healthy battery)</th></tr></thead>
    <tbody>
      {#each table.rows as row (row.battery)}
        <tr>
          <th scope="row" class="name">{row.battery}</th>
          <td class:warn={row.pastCount > 0}>{batteryVerdict(row, table.line)}</td>
          <td class="num" data-label="Worst">{#if row.worst}{#if onOpen}<button class="link" title={`Open ${row.worst.longLabel} in Match review`} onclick={() => onOpen(row.worst!.summary)}>{row.worst.label}</button>{:else}{row.worst.label}{/if} {where(row.worst)}{/if}</td>
          <td class="each" data-label={`Each ${unit}`}>
            {#each row.matches as m, i (m.summary.fileName)}{i ? ' · ' : ''}<span class:past={m.past} title={`${m.longLabel}: ${where(m)}${m.partly ? '; compared only up to the healthy curve\'s end' : ''}`}>{m.label} {m.volts === null ? '—' : m.volts.toFixed(2)}{m.partly ? '*' : ''}</span>{/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="key">The line is {table.line} V below a healthy battery (power/battery-collapse). * The {unit} drew more charge than the healthy battery curve covers ({table.curveEndAh} Ah), so the rest of it went unchecked.{table.unnamed ? ` ${table.unnamed} ${table.unnamed === 1 ? unit : units} with no battery name ${table.unnamed === 1 ? 'is' : 'are'} left out.` : ''}</p>
{/if}

<style>
  .batteries { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .batteries th, .batteries td { text-align: left; vertical-align: top; padding: 0.4rem 0.6rem 0.4rem 0; border-bottom: 1px solid var(--border); font-weight: normal; }
  .batteries thead th { font-size: 0.75rem; color: var(--muted); border-bottom-color: var(--fg); }
  .name { font-weight: 600; white-space: nowrap; }
  .num { white-space: nowrap; }
  .warn, .past { color: var(--warning); }
  .hint, .key { color: var(--muted); font-size: 0.75rem; max-width: 80ch; }
  .link { border: none; background: none; color: var(--focus); font: inherit; cursor: pointer; padding: 0 0.15rem; min-height: 24px; min-width: 24px; box-sizing: border-box; }

  /* Under 640 px each battery is a block, as the Trends table does. */
  @media (max-width: 639px) {
    .batteries thead { display: none; }
    .batteries, .batteries tbody, .batteries tr, .batteries th, .batteries td { display: block; width: auto; }
    .batteries tr { padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .batteries th, .batteries td { border: 0; padding: 0.1rem 0; }
    .num::before, .each::before { content: attr(data-label) ': '; color: var(--muted); font-size: 0.75rem; }
    .num { white-space: normal; }
  }
</style>
