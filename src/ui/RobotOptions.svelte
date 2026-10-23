<!-- The <option>s of a robot list (Session view, Match review): groups from robotChoices, a heading only where a group has one. -->
<script lang="ts">
  import { profileId } from '../profiles/index.ts'
  import type { RobotGroup } from './robot-list.ts'

  let { groups, selectedId }: { groups: RobotGroup[]; selectedId: string | null } = $props()
</script>

{#each groups as g (g.label ?? '')}
  {#if g.label === null}
    {#each g.profiles as p (profileId(p))}<option value={profileId(p)} selected={profileId(p) === selectedId}>{profileId(p)}</option>{/each}
  {:else}
    <optgroup label={g.label}>
      {#each g.profiles as p (profileId(p))}<option value={profileId(p)} selected={profileId(p) === selectedId}>{profileId(p)}</option>{/each}
    </optgroup>
  {/if}
{/each}
