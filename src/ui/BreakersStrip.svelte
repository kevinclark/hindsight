<!--
  The Breakers strip: one line saying which breakers the robot has, the same wherever it appears (Foresight below the verdict,
  the Power tab's header). "Open map" goes to the power map screen. Unset, it says the warnings are judged against the legal
  breakers and the button reads "Set".
-->
<script lang="ts">
  import { powerMapAt, type PowerMap } from '../power/power-map.ts'
  import { stripText } from '../power/power-map-view.ts'
  import { mapRobotIds, robotKey } from '../profiles/index.ts'
  import type { RobotProfile } from '../profiles/types.ts'
  import { mapHistory, openPowerMap } from './power-map-bridge.svelte.ts'

  let { profile, map }: {
    profile: Pick<RobotProfile, 'name' | 'code' | 'keptAs' | 'motorGroups' | 'breakerDefault'> | null
    /** The map to read (the Power tab passes the one this match was judged with); unset: the robot's map now. */
    map?: PowerMap | null
  } = $props()
  const robot = $derived(profile ? robotKey(profile as RobotProfile) : null)
  const shown = $derived(map !== undefined ? map : profile ? powerMapAt(mapHistory(), mapRobotIds(profile as RobotProfile), '9999-12-31T23:59:59.999Z') : null)
  const motors = $derived(profile ? profile.motorGroups.flatMap((g) => g.motors.map((m) => ({ name: m.name, canId: m.canId }))) : [])
  const line = $derived(stripText(shown, motors, profile?.breakerDefault))
</script>

<p class="strip screen-only" data-breakers-strip>
  <span>{line.text}</span>
  <button class="link" type="button" onclick={() => openPowerMap(robot ? { robot } : {})}>{line.unset ? 'Set' : 'Open map'}</button>
</p>

<style>
  .strip { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: baseline; margin: 0.5rem 0; padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; color: var(--muted); }
  .link { background: none; border: none; padding: 0; color: var(--link, var(--fg)); text-decoration: underline; cursor: pointer; font: inherit; min-height: 24px; }
</style>
