<!-- The rule track record table (slice 8): every rule that fired at this event with how often the team called it not a real problem, counts beside the rate. Collapsed. -->
<script lang="ts">
  import type { RuleRate } from '../board/model.ts'
  let { rates }: { rates: RuleRate[] } = $props()
</script>

<details class="rates">
  <summary>What the team's marks say about each rule ({rates.length} rule{rates.length === 1 ? '' : 's'} fired at this event)</summary>
  {#if rates.length === 0}
    <p class="muted small">No rule fired.</p>
  {:else}
    <table>
      <thead><tr><th scope="col">Rule</th><th scope="col">Fired</th><th scope="col">What the team's marks say</th></tr></thead>
      <tbody>
        {#each rates as r (r.rule)}
          <tr><th scope="row">{r.title} <code>{r.rule}</code></th><td>{r.fired}</td><td>{r.text}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="muted small">Counted once per issue per match, over the logs open here and every match named on a mark. A rule with no marks has no rate yet.</p>
  {/if}
</details>
