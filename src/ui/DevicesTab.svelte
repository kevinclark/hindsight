<!--
  The CTRE devices of a log, read from its .hoot files through CTRE's owlet (ADR 13): each device's supply voltage on one
  shared time axis and one shared voltage scale (Tufte's small multiples), its faults and restarts marked, its lowest
  voltage, peak current and temperature beside it. Grey for normal, colour only for a fault (ISA-101). A row opens to
  its full plots (NN/g progressive disclosure). A view, not a judgement: nothing here becomes a finding.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { hub, type Progress } from '../hub/bridge.ts'
  import type { HootReading, HootReadReport, HootStatus } from '../hoot/types.ts'
  import { align, edgesOf, type Alignment } from '../hoot/align.ts'
  import { deviceRows, enabledSpans, profileNames, type DeviceRow } from '../hoot/view.ts'
  import { matchWhen } from '../match/match.ts'
  import { readNumbers } from '../readers/wpilog.ts'
  import { changes } from '../hoot/reduce.ts'
  import { size } from './job-bar.ts'
  import JobBar from './JobBar.svelte'
  import Plot from './Plot.svelte'
  import type { PlotModel } from './plot-data.ts'

  let { analysis, logPath }: { analysis: Analysis; logPath: string } = $props()
  const api = hub()!
  const m = $derived(analysis.match)

  let status = $state<HootStatus | null>(null)
  let report = $state<HootReadReport | null>(null)
  let problem = $state('')
  let progress = $state<Progress | null>(null)
  let ticked = $state(false)
  let open = $state<string | null>(null)

  $effect(() => api.onHootProgress((p) => { progress = p }))
  $effect(() => { void api.hootRunning().then((p) => { progress ??= p }) })

  async function refresh(path: string) {
    problem = ''
    report = null
    try {
      status = await api.hootFor(path)
      if (readable(status)) await read(path)
    } catch (e) { problem = words(e) }
  }
  $effect(() => { void refresh(logPath) })

  const words = (e: unknown) => (e instanceof Error ? e.message : String(e))
  const held = $derived(status?.files.filter((f) => f.held) ?? [])
  const away = $derived(status?.files.filter((f) => !f.held) ?? [])
  /** Formats this log's held files need an owlet for and this computer has none. */
  const missing = $derived([...new Set(held.filter((f) => !f.owlet && f.compliancy !== null).map((f) => f.compliancy!))])
  const readable = (s: HootStatus) => s.licence && s.files.some((f) => f.held && f.owlet)

  async function read(path = logPath) {
    problem = ''
    try { report = await api.readHoots(path) } catch (e) { problem = words(e) }
  }
  async function accept() {
    await api.acceptCtreLicence()
    await refresh(logPath)
  }
  async function getOwlet(compliancy: number) {
    problem = ''
    try { await api.getOwlet(compliancy); await refresh(logPath) } catch (e) { problem = words(e) }
  }
  async function fetchAway() {
    problem = ''
    try { await api.fetchLogs(away.map((f) => f.path)); await refresh(logPath) } catch (e) { problem = words(e) }
  }

  // The robot log's own enables and disables, which each .hoot is lined up against.
  const logEdges = $derived.by(() => {
    const key = m.profile.signals.enabled
    const s = key ? readNumbers(m.log, key) : null
    return edgesOf(changes(s).map((c) => ({ t: c.t, on: c.v !== 0 })))
  })
  const alignments = $derived((report?.readings ?? []).map((r) => align(edgesOf(r.enable), logEdges, r.enable.some((e) => e.on))))
  const names = $derived(profileNames(m.profile, report?.readings ?? []))

  /** The window drawn: the match (else the log) on the robot log's clock; a .hoot that can't be lined up, its own span. */
  function windowOf(r: HootReading, a: Alignment): { from: number; to: number; shift: number } {
    if (a.offset === null) return { from: r.start, to: r.end, shift: 0 }
    return { from: (m.matchStart ?? m.logStart) - 2, to: (m.matchEnd ?? m.logEnd) + 2, shift: a.offset }
  }
  const when = (t: number, a: Alignment) => (a.offset === null ? `${t.toFixed(1)} s into the .hoot` : matchWhen(m, t + a.offset))
  const busLabel = (bus: string) => (bus.toLowerCase() === 'rio' ? "roboRIO's CAN bus" : `CANivore ${bus.slice(0, 4)}…${bus.slice(-4)}`)
  const f1 = (x: number | null, unit: string, digits = 1) => (x === null ? '—' : `${x.toFixed(digits)} ${unit}`)

  /** One voltage scale for every strip of a file, so rows compare by eye. */
  function voltScale(rows: DeviceRow[]): { lo: number; hi: number } {
    let lo = Infinity, hi = -Infinity
    for (const row of rows) for (const v of row.device.volts ?? []) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
    return Number.isFinite(lo) ? { lo: Math.floor(Math.min(lo, 10)), hi: Math.ceil(Math.max(hi, 13)) } : { lo: 6, hi: 14 }
  }

  const W = 360, H = 26
  function stripPath(row: DeviceRow, w: { from: number; to: number; shift: number }, scale: { lo: number; hi: number }): string {
    const d = row.device
    if (!d.volts) return ''
    const x = (t: number) => ((t + w.shift - w.from) / (w.to - w.from)) * W
    const y = (v: number) => H - 2 - ((v - scale.lo) / (scale.hi - scale.lo)) * (H - 4)
    const broken = (a: number, b: number) => d.gaps.some((g) => g.from <= a && g.to >= b)
    let path = ''
    let last: number | null = null
    for (let i = 0; i < d.t.length; i++) {
      const v = d.volts[i]
      const px = x(d.t[i])
      if (!Number.isFinite(v) || px < 0 || px > W) { last = null; continue }
      const start = last === null || broken(d.t[last], d.t[i])
      path += `${start ? 'M' : 'L'}${px.toFixed(1)},${y(v).toFixed(1)}`
      last = i
    }
    return path
  }
  const xOf = (t: number, w: { from: number; to: number; shift: number }) => ((t + w.shift - w.from) / (w.to - w.from)) * W

  function detail(row: DeviceRow, a: Alignment, w: { from: number; to: number; shift: number }): PlotModel[] {
    const d = row.device
    const shift = (ts: number[]) => ts.map((t) => t + w.shift)
    const markers = row.events.map((e) => ({ t: e.t + w.shift, label: e.what }))
    const base = { from: w.from, to: w.to, markers, matchStart: a.offset === null ? null : m.matchStart }
    const plots: PlotModel[] = []
    if (d.volts) plots.push({ ...base, unit: 'V', series: [{ label: 'Supply voltage (lowest per ¼ s)', t: shift(d.t), v: d.volts }] })
    if (d.amps) plots.push({ ...base, unit: 'A', series: [{ label: 'Supply current (highest per ¼ s)', t: shift(d.t), v: d.amps }] })
    if (d.temp) plots.push({ ...base, unit: '°C', series: [{ label: 'Temperature (highest per second)', t: shift(d.temp.t), v: d.temp.c }] })
    return plots
  }
</script>

<section class="devices">
  {#if progress}<JobBar {progress} onStop={() => void api.hootCancel()} />{/if}
  {#if problem}<p class="problem" role="alert">{problem}</p>{/if}

  {#if !status}
    <p class="note">Looking for this log's .hoot files…</p>
  {:else if status.files.length === 0}
    <p class="note">No .hoot file for this log. With Phoenix's signal logging on, the robot writes one per CAN bus; the Library pulls them with the log and shows each CTRE device's voltage, current, temperature and faults here.</p>
  {:else}
    {#if away.length}
      <p class="note">{away.length === 1 ? "This log's .hoot is" : `${away.length} of this log's .hoot files are`} on the team Drive, not on this computer ({size(away.reduce((n, f) => n + f.size, 0))}).
        <button class="button" disabled={!!progress} onclick={fetchAway}>Download</button></p>
    {/if}

    {#if held.length && !status.licence}
      <div class="licence">
        <p><strong>Reading .hoot files needs CTRE's converter, owlet.</strong> owlet is CTRE's software, used under CTRE's licence: an agreement between you and CTRE, not with Hindsight. Hindsight runs a copy already on this computer (AdvantageScope keeps one) or downloads it from CTRE's own server.</p>
        <p><a href="https://raw.githubusercontent.com/CrossTheRoadElec/Phoenix-Releases/refs/heads/master/CTRE_LICENSE.txt" target="_blank" rel="noreferrer">Read CTRE's licence</a></p>
        <label class="tick"><input type="checkbox" bind:checked={ticked} /> I accept CTRE's licence for owlet</label>
        <button class="button" disabled={!ticked} onclick={accept}>{held.every((f) => f.owlet) ? "Use CTRE's converter" : "Accept"}</button>
      </div>
    {:else if held.length}
      {#each missing as c (c)}
        <p class="note">No owlet on this computer reads {held.filter((f) => f.compliancy === c).length === 1 ? 'this .hoot' : 'these .hoot files'} (format {c}).
          {#if status.canDownload}<button class="button" disabled={!!progress} onclick={() => getOwlet(c)}>Get CTRE's converter</button> (about 4 MB from CTRE's server){:else}CTRE has no owlet for this kind of computer.{/if}</p>
      {/each}
    {/if}

    {#if report}
      {#each report.problems as p (p.file)}
        <p class="problem">{p.file}: {p.why}
          {#if /could not start/.test(p.why) && status.canDownload}{@const f = held.find((h) => h.name === p.file)}{#if f?.compliancy != null}<button class="button" disabled={!!progress} onclick={() => getOwlet(f.compliancy!)}>Get CTRE's converter again</button>{/if}{/if}</p>
      {/each}
      {#each report.readings as r, k (r.file)}
        {@const a = alignments[k]}
        {@const w = windowOf(r, a)}
        {@const rows = deviceRows(r, names[k])}
        {@const scale = voltScale(rows)}
        <h3>{busLabel(r.bus)} <span class="meta">{r.file} · owlet {r.owlet}</span></h3>
        {#if r.cutShort}<p class="note">The file ends early (owlet: "{r.cutShort}"): everything before that point is shown.</p>{/if}
        {#if rows.length === 0}
          <p class="note">No devices on this bus.</p>
        {:else}
          <p class="note">
            {#if a.offset !== null}Lined up with this log by {a.matched} enables and disables (they agree to within {a.spread.toFixed(2)} s).
            {:else}Not lined up with this log: {a.why}. Drawn on the .hoot's own clock, not the match clock.{/if}
            Voltage {scale.lo}–{scale.hi} V on every row; shaded: enabled. Lowest voltage and peak current are while enabled.
          </p>
          <table>
            <thead><tr><th>Device</th><th>Supply voltage</th><th class="num">Lowest</th><th class="num">Peak A</th><th class="num">Peak temp</th><th>Faults and restarts</th></tr></thead>
            <tbody>
              {#each rows as row (row.device.name)}
                {@const id = `${r.file}/${row.device.name}`}
                <tr class:flagged={row.events.length > 0} class:open={open === id} onclick={() => (open = open === id ? null : id)}>
                  <th scope="row"><button class="link" aria-expanded={open === id}>{row.label}</button></th>
                  <td class="strip">
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${row.label} supply voltage`}>
                      {#each enabledSpans(r) as s (s.start)}
                        <rect class="enabled" x={Math.max(0, xOf(s.start, w))} width={Math.max(0, Math.min(W, xOf(s.end, w)) - Math.max(0, xOf(s.start, w)))} y="0" height={H} />
                      {/each}
                      <path d={stripPath(row, w, scale)} />
                      {#each row.events as e (e.t + e.what)}
                        {#if xOf(e.t, w) >= 0 && xOf(e.t, w) <= W}<line class:reset={e.what === 'restarted'} class="event" x1={xOf(e.t, w)} x2={xOf(e.t, w)} y1="0" y2={H} />{/if}
                      {/each}
                    </svg>
                  </td>
                  <td class="num">{f1(row.lowestVolts, 'V', 2)}</td>
                  <td class="num">{f1(row.peakAmps, 'A')}</td>
                  <td class="num">{f1(row.peakTemp, '°C')}</td>
                  <td class="events">{#each row.events as e, i (e.t + e.what)}{#if i > 0}<br />{/if}<strong>{e.what}</strong>{' '}{when(e.t, a)}{/each}</td>
                </tr>
                {#if open === id}
                  <tr class="detail"><td colspan="6">{#each detail(row, a, w) as p (p.unit)}<Plot model={p} height={110} />{/each}</td></tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
      {/each}
    {/if}
  {/if}
</section>

<style>
  .note { font-size: 0.85rem; color: var(--muted); max-width: 80ch; }
  .problem { font-size: 0.85rem; color: var(--error); max-width: 80ch; }
  h3 { font-size: 1rem; margin: 1.25rem 0 0.25rem; }
  h3 .meta { font-weight: normal; font-size: 0.8rem; color: var(--muted); }
  .licence { border-left: 3px solid var(--border); padding: 0.25rem 0.75rem; max-width: 80ch; font-size: 0.9rem; }
  .tick { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 24px; margin-right: 1rem; }
  .tick input { width: 24px; height: 24px; margin: 0; }
  table { border-collapse: collapse; font-size: 0.85rem; font-variant-numeric: tabular-nums; width: 100%; }
  td.num, th.num { white-space: nowrap; text-align: right; }
  td.strip { width: 40%; min-width: 12rem; }
  th, td { text-align: left; padding: 0.15rem 1rem 0.15rem 0; vertical-align: middle; }
  thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  tbody th { font-weight: normal; white-space: nowrap; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--hover); }
  tr.detail { cursor: default; background: none; }
  tr.detail:hover { background: none; }
  .events { color: var(--muted); }
  tr.flagged .events strong { color: var(--error); }
  svg { display: block; width: 100%; height: 26px; }
  svg path { fill: none; stroke: var(--fg); stroke-width: 1; opacity: 0.75; vector-effect: non-scaling-stroke; }
  svg .enabled { fill: var(--hover); }
  svg .event { stroke: var(--error); stroke-width: 2; vector-effect: non-scaling-stroke; }
  svg .event.reset { stroke: var(--warning); }
  .button { display: inline-block; padding: 0.3rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; min-height: 24px; }
  .button:disabled { opacity: 0.5; cursor: default; }
  button.link { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; min-height: 24px; }
</style>
