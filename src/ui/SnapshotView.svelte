<!--
  Robot snapshot: what every CTRE device on the robot reports about itself (inventory, applied current limits,
  sticky faults), read by tools/robot-snapshot.py and compared here with the robot profile. Drop a second snapshot
  to see what changed between them. Nothing here talks to the robot.
-->
<script lang="ts">
  import { PROFILES, profileId } from '../profiles/index.ts'
  import { busLabel, parseSnapshot, type Snapshot } from '../snapshot/snapshot.ts'
  import { chooseProfile, fieldText, inventory, LIMIT_FIELDS, limitsReport, POWER_FAULTS, stickyFaults, type InventoryStatus, type SnapshotProfile } from '../snapshot/report.ts'
  import { diffSnapshots } from '../snapshot/diff.ts'
  import { keptId } from '../builder/store.ts'
  import { toProfile } from '../builder/json.ts'
  import { keptNow } from './kept-profiles.svelte.ts'

  /** `limitsFrom`: the snapshot (its takenAt) a kept profile's limits were read from. */
  type Choice = { id: string; profile: SnapshotProfile; limitsFrom?: string }
  const builtIn: Choice[] = $derived([
    ...PROFILES.map((p) => ({ id: profileId(p), profile: p })),
    ...keptNow().map((j) => ({ id: keptId(j), profile: toProfile(j) as SnapshotProfile, limitsFrom: j.limitsFrom?.snapshotTakenAt })),
  ])

  let snapshots = $state<Snapshot[]>([])
  let dropped = $state<Choice[]>([])
  let robot = $state('auto')
  let problems = $state<string[]>([])
  let dragging = $state(false)

  const ordered = $derived([...snapshots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)))
  const current = $derived(ordered[ordered.length - 1] as Snapshot | undefined)
  const choices = $derived([...dropped, ...builtIn])
  const auto = $derived(current ? chooseProfile(current, choices.map((c) => c.profile)) : null)
  const profile = $derived(robot === 'auto' ? auto : (choices.find((c) => c.id === robot)?.profile ?? null))
  // A kept profile whose limits were read from this very snapshot: comparing them with it would compare the robot with itself.
  const selfCompared = $derived(!!current && !!profile && choices.find((c) => c.profile === profile)?.limitsFrom === current.takenAt)
  const rows = $derived(current ? inventory(current, profile) : [])
  const limits = $derived(current ? limitsReport(current, profile) : null)
  const faults = $derived(current ? stickyFaults(current, profile) : [])
  const withFaults = $derived(faults.filter((f) => f.set.length > 0))
  const unreadable = $derived(faults.filter((f) => f.unreadable.length > 0))
  const diff = $derived(ordered.length === 2 ? diffSnapshots(ordered[0], ordered[1]) : null)

  const STATUS_ORDER: InventoryStatus[] = ['missing', 'ambiguous', 'extra', 'no-can-id', 'found', 'other']
  const STATUS_WORDS: Record<InventoryStatus, string> = { found: 'found', missing: 'missing', ambiguous: 'duplicate ID', 'no-can-id': 'no CAN ID in profile', extra: 'not in profile', other: 'other device' }
  const sortedRows = $derived([...rows].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)))
  const count = (s: InventoryStatus) => rows.filter((r) => r.status === s).length
  const GROUP_WORDS = { clean: 'matches the profile', differs: 'differs', partly: 'matches where checked', 'not-checked': 'not checked' }

  async function load(list: FileList | File[] | null) {
    const files = Array.from(list ?? [])
    const found: string[] = []
    for (const f of files) {
      try {
        const text = await f.text()
        const json = JSON.parse(text)
        if (json && Array.isArray(json.motorGroups) && typeof json.name === 'string') {
          const bad = json.motorGroups.findIndex((g: unknown) => !isGroup(g))
          if (bad !== -1) throw new Error(`${f.name}: motor group ${bad + 1} needs a name, a motors list (each with a name, and a number canId if it has one) and limits with "where"`)
          const id = `${json.name} (from ${f.name})`
          dropped = [{ id, profile: json as SnapshotProfile }, ...dropped.filter((d) => d.id !== id)]
          robot = id
          continue
        }
        const s = parseSnapshot(text, f.name)
        // Keep the two newest; the same file again replaces itself.
        const kept = snapshots.filter((x) => x.takenAt !== s.takenAt || x.fileName !== s.fileName)
        snapshots = [...kept, s].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)).slice(-2)
      } catch (error) {
        found.push(error instanceof Error ? error.message : `${f.name}: ${error}`)
      }
    }
    problems = found
  }

  function isGroup(g: unknown): boolean {
    const x = g as { name?: unknown; motors?: unknown; limits?: { where?: unknown } }
    return !!x && typeof x.name === 'string' && Array.isArray(x.motors) && !!x.limits && typeof x.limits === 'object' && typeof x.limits.where === 'string'
      && x.motors.every((m: { name?: unknown; canId?: unknown }) => !!m && typeof m.name === 'string' && (m.canId === undefined || typeof m.canId === 'number'))
  }

  function remove(s: Snapshot) { snapshots = snapshots.filter((x) => x !== s) }
  const when = (s: Snapshot) => new Date(s.takenAt).toLocaleString()
  const corsLine = (s: Snapshot) => !s.versionRead ? 'not checked (the server never answered)'
    : s.allowOrigin === null ? 'the server sent no Access-Control-Allow-Origin header, so a page can\'t read it directly; the collector stays the way in'
    : `Access-Control-Allow-Origin: ${s.allowOrigin}${s.allowOrigin === '*' || s.allowOrigin === 'null' ? ' (a page opened from a file could read the server directly)' : ''}`
</script>

<svelte:window ondragover={(e) => { e.preventDefault() }} />

<p class="intro">
  A <strong>robot snapshot</strong> is what every CTRE device on the robot says about itself: model, CAN ID, firmware, the current limits it is
  really running, and its sticky faults. Take one with <code>python3 tools/robot-snapshot.py</code> while the robot is on and tethered
  (see <code>docs/robot-snapshot.md</code>), then drop its <code>snapshot.json</code> here. Drop a second one to see what changed between them.
</p>

<section class="drop" class:dragging aria-label="Drop a snapshot"
  ondragover={(e) => { e.preventDefault(); dragging = true }} ondragleave={() => (dragging = false)}
  ondrop={(e) => { e.preventDefault(); dragging = false; load(e.dataTransfer?.files ?? null) }}>
  <label class="button">
    <input type="file" multiple accept=".json" onchange={(e) => { const input = e.currentTarget as HTMLInputElement; load(input.files); input.value = '' }} />
    Choose snapshot.json…
  </label>
  <span>or drop it here. A robot profile file (<code>.json</code> with <code>motorGroups</code>) works too.</span>
</section>

{#each problems as p (p)}<p class="problem" role="alert">{p}</p>{/each}

{#if current}
  <div class="loaded">
    {#each ordered as s (s.takenAt + s.fileName)}
      <span class="chip">{s.fileName} · {when(s)} <button class="link" onclick={() => remove(s)} aria-label="Remove {s.fileName}">×</button></span>
    {/each}
  </div>

  <section class="head">
    <h2>Robot snapshot, {when(current)}</h2>
    <p class="meta">
      {[current.address ? `From ${current.address}` : 'Hoot files only (no robot)', current.serverVersion && `diagnostic server ${current.serverVersion}`,
        `${current.devices.length} device${current.devices.length === 1 ? '' : 's'}`, current.busUtilPerc !== null && current.busUtilPerc >= 0 && `bus ${current.busUtilPerc.toFixed(0)} % busy`,
        `collector ${current.collectorVersion || '?'}`, current.route?.interface && `via ${current.route.interface}`].filter(Boolean).join(' · ')}
    </p>
    <p class="meta">CORS: {corsLine(current)}.</p>
    {#if current.responseShapes !== 'robot'}<p class="meta">How these answers are read was checked against CTRE's simulator, not yet a real robot: anything shown as "unreadable" is a sign it reads differently.</p>{/if}
    {#if current.stopped}
      <p class="warn" role="alert"><strong>Incomplete:</strong> the collector stopped at <code>{current.stopped.action}</code>{#if current.stopped.device} for {current.stopped.device}{/if}: {current.stopped.reason}. Devices after that weren't read.</p>
    {/if}
    {#if current.address}
      <p class="meta">Robot profile:
        <select bind:value={robot} aria-label="Robot profile">
          <option value="auto">automatic{auto ? ` (${auto.name})` : ' (none matches)'}</option>
          {#each choices as c (c.id)}<option value={c.id}>{c.id}</option>{/each}
        </select>
      </p>
    {/if}
  </section>

  {#if current.address && current.devices.length === 0}
    <p class="warn">No device list in this snapshot{current.stopped ? ': the collector stopped before reading it' : ''}. Nothing to compare.</p>
  {:else if current.address}
    <section class="faults">
      <h3>Sticky faults</h3>
      <p class="banner"><strong>Clear faults only after you've saved this snapshot.</strong> Phoenix Tuner X's "Clear Faults" (and blinking a device) wipes this evidence.</p>
      {#if withFaults.length === 0}
        <p class="ok">No sticky faults on the {faults.length} device{faults.length === 1 ? '' : 's'} read.</p>
      {:else}
        <table class="list">
          <thead><tr><th>device</th><th>CAN ID</th><th>sticky faults</th></tr></thead>
          <tbody>
            {#each withFaults as d (d.device.key)}
              <tr data-device={d.label}><td>{d.label}</td><td>{d.device.id} <small>{busLabel(d.device.bus)}</small></td>
                <td>{#each d.set as f, i (f.signal)}{i ? ', ' : ''}<span class:power={POWER_FAULTS.includes(f.name)}>{f.name}</span>{/each}</td></tr>
            {/each}
          </tbody>
        </table>
        <p class="note">Undervoltage: the supply voltage sagged near brownout. BridgeBrownout: the output bridge shut off for low voltage. BootDuringEnable: the device restarted while the robot was enabled (a power dip or a loose connection). Sticky means it happened at least once since the faults were last cleared, not that it is happening now.</p>
        {#if faults.length > withFaults.length}<p class="note">No sticky faults on the other {faults.length - withFaults.length} device{faults.length - withFaults.length === 1 ? '' : 's'} read.</p>{/if}
      {/if}
      {#if unreadable.length}
        <p class="warn">Couldn't read {unreadable.reduce((n, d) => n + d.unreadable.length, 0)} fault value{unreadable.reduce((n, d) => n + d.unreadable.length, 0) === 1 ? '' : 's'} on {unreadable.length} device{unreadable.length === 1 ? '' : 's'} (e.g. {unreadable[0].label}: {unreadable[0].unreadable[0].signal} = {unreadable[0].unreadable[0].raw}). Treat these as unknown, not clear.</p>
      {/if}
    </section>

    <section class="inventory">
      <h3>Inventory</h3>
      <p class="note">
        {#if profile}Against <strong>{profile.name}</strong>: {count('found')} found{#if count('missing')}, <span class="bad">{count('missing')} missing</span>{/if}{#if count('ambiguous')}, <span class="bad">{count('ambiguous')} duplicate ID</span>{/if}{#if count('extra')}, {count('extra')} not in the profile{/if}{#if count('no-can-id')}, {count('no-can-id')} with no CAN ID in the profile{/if}.
        {:else}No robot profile matches these CAN IDs: pick one above to compare.{/if}
      </p>
      <div class="wrap">
        <table class="list">
          <thead><tr><th>status</th><th>profile</th><th>model</th><th>CAN ID</th><th>bus</th><th>firmware</th><th>Pro</th></tr></thead>
          <tbody>
            {#each sortedRows as r, i (i)}
              {@const d = r.devices[0]}
              <tr data-status={r.status}>
                <td><span class="chip {r.status}">{STATUS_WORDS[r.status]}</span></td>
                <td>{#if r.motor}{r.motor.name} <small>{r.motor.group}</small>{/if}</td>
                <td>{d?.model ?? '—'}</td>
                <td>{d?.id ?? r.motor?.canId ?? '—'}</td>
                <td>{d ? busLabel(d.bus) : '—'}</td>
                <td>{d?.firmware || '—'}</td>
                <td>{d ? (d.pro ? 'yes' : 'no') : '—'}</td>
              </tr>
              {#if r.note}<tr class="sub"><td></td><td colspan="6">{r.note}</td></tr>{/if}
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    {#if limits && profile && selfCompared}
      <section class="limits">
        <h3>Current limits</h3>
        <p class="note self-compared">These limits were read from this same snapshot, so comparing them with it would compare the robot with itself. Drop a newer snapshot to see what changed.</p>
      </section>
    {:else if limits && profile}
      <section class="limits">
        <h3>Current limits</h3>
        <p class="note">What each motor is really running, read from the motor, against the limits the code sets (the profile). A motor that differs had a failed <code>apply()</code> when the robot code started, or still has a Phoenix Tuner X edit (the next deploy or restart re-applies the code's config).</p>
        {#each limits.groups as g (g.group)}
          <div class="group" data-group={g.group} data-status={g.status}>
            <h4>{g.group} <span class="chip {g.status}">{GROUP_WORDS[g.status]}</span></h4>
            <p class="meta">Set in <code>{g.where}</code>{#if g.disagree.length} · <span class="bad">the motors disagree with each other on: {g.disagree.join(', ')}</span>{/if}</p>
            {#each g.motors.filter((m) => m.status === 'differs') as m (m.motor)}
              <p class="bad" role="alert"><strong>{m.motor}</strong> (CAN {m.canId}) differs: {m.fields.filter((f) => f.ok === false).map((f) => `${f.label} ${fieldText(f, 'applied')}, ${f.expectedFrom === 'profile' ? 'the code sets' : 'Phoenix default'} ${fieldText(f, 'expected')}`).join('; ')}.</p>
            {/each}
            {#each g.motors.filter((m) => m.status === 'unreadable') as m (m.motor)}
              <p class="warn">{m.motor}: {m.fields.filter((f) => f.ok === null).length} of its limit settings couldn't be read (shown as —), so this motor isn't counted as matching.</p>
            {/each}
            {#each g.motors.filter((m) => m.supplyOff) as m (m.motor)}
              <p class={m.supplyOff === 'unexpected' ? 'bad' : 'note'}>{m.motor}: supply current limit switched off{m.supplyOff === 'as-profile' ? ', as the code says' : ''}. Nothing caps the current it draws from the battery.</p>
            {/each}
            <div class="wrap">
              <table class="list limits-table">
                <thead><tr><th>motor</th><th>CAN ID</th><th>stator</th><th>on</th><th>supply</th><th>on</th><th>lower</th><th>after</th></tr></thead>
                <tbody>
                  {#each g.motors as m (m.motor)}
                    <tr data-motor={m.motor} data-status={m.status}>
                      <td>{m.motor}</td><td>{m.canId ?? '—'}</td>
                      {#if m.fields.length}
                        {#each m.fields as f (f.signal)}<td class:bad={f.ok === false} class:unknown={f.ok === null} title={`${f.signal}: expected ${fieldText(f, 'expected')} (${f.expectedFrom})`}>{fieldText(f, 'applied')}</td>{/each}
                      {:else}
                        <td colspan="6" class="muted">{({ 'not-on-bus': 'not on the bus', 'no-can-id': 'no CAN ID in the profile', ambiguous: 'its CAN ID is on more than one device or bus: can\'t tell which answered', 'no-configs': 'configs not read', unreadable: '', ok: '', differs: '' })[m.status]}</td>
                      {/if}
                    </tr>
                  {/each}
                  <tr class="expected"><td>the code sets</td><td></td>
                    {#each (g.motors.find((m) => m.fields.length)?.fields ?? LIMIT_FIELDS.map((spec) => ({ signal: spec.signal, unit: spec.unit, expected: (profile.motorGroups.find((x) => x.name === g.group)?.limits[spec.key] ?? null) as number | boolean | null, expectedFrom: 'profile' }))) as f (f.signal)}<td>{f.expected === null ? 'default' : fieldText(f, 'expected')}{f.expectedFrom === 'Phoenix default' ? '*' : ''}</td>{/each}</tr>
                </tbody>
              </table>
            </div>
          </div>
        {/each}
        <p class="note">* not set in the code: Phoenix's default applies.</p>
        {#each limits.supplyOffElsewhere as d (d.key)}
          <p class="warn">{d.model} {d.id} ({busLabel(d.bus)}), not in the profile: supply current limit switched off.</p>
        {/each}
      </section>
    {/if}
  {/if}

  {#if diff}
    <section class="diff">
      <h3>What changed</h3>
      <p class="note">From {when(diff.earlier)} to {when(diff.later)}: {diff.changes.length} change{diff.changes.length === 1 ? '' : 's'} in devices, firmware, configs and sticky faults (live readings like voltage are left out).</p>
      {#if diff.changes.length}
        <table class="list">
          <thead><tr><th>device</th><th>what</th><th>before</th><th>after</th></tr></thead>
          <tbody>{#each diff.changes as c, i (i)}<tr><td>{c.device}</td><td>{c.kind}{c.field ? `: ${c.field}` : ''}</td><td>{c.before}</td><td>{c.after}</td></tr>{/each}</tbody>
        </table>
      {/if}
    </section>
  {/if}

  {#if current.hoot}
    <section class="hoot">
      <h3>Phoenix hoot logs</h3>
      {#if current.hoot.listed}<p class="note">{current.hoot.listed} .hoot file{current.hoot.listed === 1 ? '' : 's'} on the robot.</p>{/if}
      <ul>
        {#each current.hoot.files as f (f.name)}
          <li><code>{f.name}</code>: {#if f.wpilog}converted to <code>hoot/{f.wpilog}</code>{f.pro === false ? ' (no Pro device: only the free signals)' : ''}; {f.signals.length} signal{f.signals.length === 1 ? '' : 's'}{f.signals.length && f.signals.length <= 6 ? ` (${f.signals.join(', ')})` : ''}{:else}{f.note ?? 'not converted'}{/if}</li>
        {/each}
      </ul>
      {#each current.hoot.notes as n (n)}<p class="warn">{n}</p>{/each}
      <p class="note">Open the converted <code>.wpilog</code> files in Match review. To line one up with the robot's own log, match the moments the robot was enabled (RobotEnable), not the times in the file names: those were off by several seconds.</p>
    </section>
  {/if}
{:else}
  <section class="empty">
    <h3>Before you start</h3>
    <ol>
      <li><strong>Don't press "Clear Faults" or blink any device in Phoenix Tuner X</strong> before the snapshot: it erases the sticky faults this reads.</li>
      <li>Robot on, robot code running, laptop on the roboRIO's USB port (or the robot's network). It doesn't need to be enabled.</li>
      <li>Run <code>python3 tools/robot-snapshot.py</code> and drop the <code>snapshot.json</code> it saves here.</li>
    </ol>
  </section>
{/if}

<style>
  .intro, .note, .meta { font-size: 0.85rem; color: var(--muted); max-width: 85ch; }
  .meta { margin: 0.15rem 0 0; overflow-wrap: anywhere; }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .drop.dragging { border-color: var(--focus); background: var(--hover); }
  .button { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within { outline: 2px solid var(--focus); }
  .problem { color: var(--error); font-size: 0.85rem; }
  .loaded { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .head { margin-top: 1rem; }
  h2 { font-size: 1.2rem; margin: 0; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  h4 { font-size: 0.95rem; margin: 1rem 0 0.1rem; }
  .banner { font-size: 0.85rem; padding: 0.4rem 0.6rem; border-left: 3px solid var(--warning); background: var(--hover); max-width: 85ch; }
  .warn { color: var(--warning); font-size: 0.85rem; max-width: 85ch; }
  .bad { color: var(--error); }
  p.bad { font-size: 0.85rem; max-width: 85ch; }
  .ok { font-size: 0.85rem; color: var(--muted); }
  .power { font-weight: 700; color: var(--error); }
  .link { border: none; background: none; color: var(--muted); font: inherit; cursor: pointer; padding: 0 0.2rem; }
  .chip { display: inline-block; font-size: 0.75rem; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; font-weight: normal; }
  .chip.missing, .chip.ambiguous, .chip.differs { border-color: var(--error); color: var(--error); }
  .chip.extra, .chip.partly { border-color: var(--warning); color: var(--warning); }
  .chip.clean, .chip.found { border-color: var(--border); }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.8rem; }
  .list th, .list td { text-align: left; padding: 0.15rem 0.9rem 0.15rem 0; vertical-align: top; }
  .list thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  .list small { color: var(--muted); }
  .list tr.sub td { color: var(--muted); padding-bottom: 0.35rem; }
  .limits-table td:nth-child(n+3), .limits-table th:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
  .limits-table td.bad { font-weight: 700; }
  .limits-table td.unknown { color: var(--muted); }
  .limits-table tr.expected td { color: var(--muted); border-top: 1px solid var(--border); }
  .muted { color: var(--muted); }
  select { font: inherit; font-size: 0.8rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; max-width: 100%; }
  .empty li { margin-bottom: 0.4rem; max-width: 75ch; }
</style>
