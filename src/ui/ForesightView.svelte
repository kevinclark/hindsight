<!--
  Foresight: the pre-match go/no-go, live from the robot over a tether in the pit or the queue (the team's onchecks).
  One verdict (GO, NO-GO, NOT CHECKED), then the findings worst first, each with the one thing to do before the robot
  goes on the field. Big enough to read at arm's length in a noisy queue.
  Read-only (src/foresight/nt4-client.ts), and never on the field: it closes for good when the field attaches.
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ForesightLive, type LiveStatus } from '../foresight/live.ts'
  import { SETTLE_SECONDS } from '../foresight/engine.ts'
  import { FIELD_MESSAGE, isFieldLocked } from '../foresight/nt4-client.ts'
  import { lastPassingSha, type HistoryEvent, type PitCheckEvent } from '../triage/history.ts'
  import { FORESIGHT_RULES } from '../rules/index.ts'
  import { profileId } from '../profiles/index.ts'
  import { num, values } from '../match/match.ts'
  import { downloadText } from './download.ts'
  import { ASSISTED_RULES, checklistLines, groupSteps, wantedLines, type ChecklistLine } from '../foresight/onchecks.ts'
  import { SNAPSHOT_RULES, type CodeSettings } from '../foresight/snapshot-checks.ts'
  import type { FolderCheck } from '../code/check/index.ts'
  import { parseSnapshot, type Snapshot } from '../snapshot/snapshot.ts'
  import type { VerdictItem } from '../foresight/verdict.ts'
  import { didNotRun } from '../report/foresight-model.ts'
  import ForesightReport from './ForesightReport.svelte'
  import CodeCheck from './CodeCheck.svelte'

  let { history, onPitCheck }: { history: HistoryEvent[]; onPitCheck: (event: PitCheckEvent) => void } = $props()

  const ADDRESSES = [
    { value: '172.22.11.2', label: 'USB tether' },
    { value: '10.80.33.2', label: 'Ethernet tether' },
    { value: 'roborio-8033-frc.local', label: 'by name' },
  ]
  let address = $state(ADDRESSES[0].value)
  let live: ForesightLive | null = null
  // What the Code panel read from the robot code, for the snapshot check (snapshot/code-settings).
  let codeSettings: CodeSettings | null = null
  function useCode(check: FolderCheck | null) {
    codeSettings = check && { commit: check.commit, ranOn: check.ranOn, settings: check.settings }
    live?.setCodeSettings(codeSettings)
  }
  let status = $state.raw<LiveStatus | null>(null)
  let recorded = false
  let open = $state<Record<string, boolean>>({})
  // A robot snapshot (tools/robot-snapshot.py) dropped here: Foresight never reads the diagnostic server itself.
  let snapshot = $state.raw<Snapshot | null>(null)
  let snapshotProblem = $state<string | null>(null)

  async function loadSnapshot(files: FileList | null | undefined) {
    const file = files?.[0]
    if (!file) return
    try {
      snapshot = parseSnapshot(await file.text(), file.name)
      snapshotProblem = null
    } catch (error) {
      snapshot = null
      snapshotProblem = error instanceof Error ? error.message : String(error)
    }
    live?.setSnapshot(snapshot)
  }

  function connect() {
    live?.disconnect()
    recorded = false
    // Compared with the last passing check from before this connection, not with this one.
    const since = lastPassingSha(history)
    live = new ForesightLive({ address, lastPassingSha: since, onUpdate: (s) => { status = s; record(s) } })
    live.setSnapshot(snapshot)
    live.setCodeSettings(codeSettings)
    live.start()
  }
  function disconnect() {
    live?.disconnect()
    live = null
  }
  onDestroy(() => live?.disconnect())

  // The first GO of a connection is kept in the history file (for foresight/commit-matches next time).
  function record(s: LiveStatus) {
    if (recorded || s.result?.state !== 'checked' || s.result.verdict.verdict !== 'GO') return
    recorded = true
    const m = s.result.match
    onPitCheck({ type: 'pit-check', verdict: 'GO', sha: m.build.sha, dirty: /uncommitted/i.test(m.build.dirty), robot: profileId(m.profile), when: new Date().toISOString() })
  }

  const result = $derived(status?.result ?? null)
  const checked = $derived(result?.state === 'checked' ? result : null)
  const connected = $derived(status?.state === 'connected' || status?.state === 'connecting')
  const field = $derived(status?.state === 'field' || (status === null && isFieldLocked()))
  const verdict = $derived(
    checked ? checked.verdict.verdict
      : 'NOT CHECKED',
  )
  const why = $derived(
    checked ? checked.verdict.reason
      : result?.state === 'settling' ? `${result.reason}: ${Math.ceil(result.secondsLeft)} s`
      : result?.state === 'enabled' ? result.reason
      : status?.state === 'connected' ? 'reading the robot…'
      : 'not connected',
  )
  const fmt = (t: number | null) => (t === null ? '—' : `${t.toFixed(1)} s`)
  // A few live values to compare with the Driver Station's own display.
  const lastNumber = (key: string) => { const s = checked ? num(checked.match, key) : null; return s && s.v.length ? s.v[s.v.length - 1] : null }
  const lastText = (key: string) => { const s = checked ? values<string>(checked.match, key) : null; return s && s.v.length ? s.v[s.v.length - 1] : null }
  const battery = $derived(checked ? lastNumber(checked.match.profile.signals.batteryVoltage) : null)
  const controllers = $derived(checked ? (checked.match.profile.foresight?.controllerNames ?? []).map((key) => lastText(key) || '(nothing)') : [])

  // Everything on this screen plus what the robot never sent, as a file for Claude (the first-robot checklist asks for it).
  function downloadReadings() {
    if (!status) return
    const store = live?.store
    const neverSent = status.subscribed.filter((k) => !store?.entries.get(k)?.t.length)
    const report = {
      schema: 'hindsight.foresight-readings/2', when: new Date().toISOString(), browser: navigator.userAgent, page: location.href.startsWith('file:') ? 'file://' : location.origin,
      url: status.url, state: status.state, message: status.message, topicsAnnounced: status.topicsAnnounced, signalsAskedFor: status.subscribed.length,
      valuesReceived: status.valuesReceived, robotTime: status.robotTime, codeStart: status.codeStart, codeStartFrom: status.codeStartFrom,
      robot: status.profile ? profileId(status.profile) : null, neverSent, battery, controllers,
      snapshot: snapshot && { file: snapshot.fileName, takenAt: snapshot.takenAt, devices: snapshot.devices.length, stopped: snapshot.stopped, responseShapes: snapshot.responseShapes, used: checked?.snapshotUsed ?? null },
      verdict: checked ? { verdict: checked.verdict.verdict, reason: checked.verdict.reason, items: checked.verdict.items.map(readingItem), notChecked: checked.verdict.notChecked, crashed: checked.verdict.crashed, build: checked.match.build } : result,
    }
    downloadText(`foresight-readings-${report.when.slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(report, null, 1))
  }
  type ReadingItem = { level: string; rule: string; title: string; explains?: ReadingItem[] }
  const readingItem = (i: VerdictItem): ReadingItem => ({ level: i.level, rule: i.finding.rule, title: i.finding.title, ...(i.explains.length ? { explains: i.explains.map(readingItem) } : {}) })
  const onchecks = $derived(checklistLines(checked))
  // Problems no check can see yet (rules/wanted.ts): grey context, never in the verdict.
  const wanted = $derived(wantedLines(checked))
  // Only red and amber items decide GO/NO-GO; grey ones (context, or a step for a person) sit in their own short list.
  const decisive = $derived(checked ? checked.verdict.items.filter((i) => i.level !== 'grey') : [])
  // Grey items that ask a person to do something (hold a tag up to a camera) are steps; the other greys are context.
  const stepItems = $derived(checked ? groupSteps(checked.verdict.items.filter((i) => i.level === 'grey' && ASSISTED_RULES.has(i.finding.rule))) : [])
  const contextItems = $derived(checked ? checked.verdict.items.filter((i) => i.level === 'grey' && !ASSISTED_RULES.has(i.finding.rule)) : [])
  const totalChecks = FORESIGHT_RULES.length + SNAPSHOT_RULES.length
  const unrun = $derived(checked ? didNotRun(checked.verdict.notChecked.length + checked.verdict.crashed.length, totalChecks) : null)
  // The checklist keeps the team's order.
  // Lines the tool can never judge (a person's) and context that is never a fault (the gyro) fold away; the rest are live.
  const liveLines = $derived(onchecks.filter((l) => !l.folded))
  const inertLines = $derived(onchecks.filter((l) => l.folded))
  const snapshotWhy = $derived(checked && !checked.snapshotUsed ? checked.report.skipped.find((s) => s.rule === SNAPSHOT_RULES[0])?.reason ?? null : null)
  let reportView = $state<{ save: () => Promise<string | null> }>()
  let saveProblem = $state<string | null>(null)
  const MARK = { ok: 'OK', red: 'Fix', amber: 'Look', 'to do': 'Do', context: 'Context', 'not checked': '– Not checked', 'by eye': 'By eye' } as const
  const LEVEL_WORD = { red: 'Fix before the field', amber: 'Look at', grey: 'Context' } as const
</script>

{#snippet checkLine(l: ChecklistLine)}
  <li class={`oc ${l.state.replace(' ', '-')}`}><span class="mark">{MARK[l.state]}</span><span class="line">{l.line}</span><span class="detail-text">{l.detail}</span></li>
{/snippet}

{#snippet itemRow(item: VerdictItem, nested = false)}
  <li class={`item ${item.level}`}>
    <button class="row" onclick={() => (open = { ...open, [item.finding.key]: !open[item.finding.key] })} aria-expanded={!!open[item.finding.key]}>
      <span class="chip">{ASSISTED_RULES.has(item.finding.rule) && item.level === 'grey' ? 'Do' : LEVEL_WORD[item.level]}</span>
      <span class="title">{item.finding.title}</span>
    </button>
    {#if nested}<p class="action">↳ {item.finding.explainedBy?.why}</p>
    {:else if item.level !== 'grey' || ASSISTED_RULES.has(item.finding.rule)}<p class="action"><strong>Do:</strong> {item.action}</p>{/if}
    {#if !nested && item.finding.explainedBy}<p class="proof">explained by {item.finding.explainedBy.rule}: {item.finding.explainedBy.why}</p>{/if}
    <p class="proof">{item.finding.rule} · {item.proof}</p>
    {#if open[item.finding.key]}
      <div class="detail">
        <p>{item.finding.meaning}</p>
        <dl>{#each Object.entries(item.finding.evidence) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
        <p class="small">Could be: {item.finding.causes.map((c) => `${c.cause} (${c.look})`).join('; ')}</p>
      </div>
    {/if}
    {#if item.explains.length}
      <ol class="items under" aria-label="The same problem, seen by other checks">
        {#each item.explains as under (under.finding.key + under.finding.title)}{@render itemRow(under, true)}{/each}
      </ol>
    {/if}
  </li>
{/snippet}

<!-- A file dropped anywhere but the snapshot box would open in this tab and end the check. -->
<svelte:window ondragover={(e) => e.preventDefault()} ondrop={(e) => e.preventDefault()} />
<div class="screen-only">
{#if field}
  <section class="field" role="alert">
    <p class="big">{FIELD_MESSAGE}</p>
    <p>Foresight disconnected the moment the field attached and will not connect again until this page is reloaded off the field.</p>
  </section>
{:else}
  <section class="connect">
    <label>Robot <input list="foresight-addresses" bind:value={address} disabled={connected} size="24" /></label>
    <datalist id="foresight-addresses">{#each ADDRESSES as a (a.value)}<option value={a.value}>{a.label}</option>{/each}</datalist>
    {#if connected}<button class="button" onclick={disconnect}>Disconnect</button>{:else}<button class="button" onclick={connect}>Connect</button>{/if}
    <span class="status">{status?.message ?? 'Tethered in the pit or queue (USB or Ethernet), robot on, Driver Station connected. Never on the field.'}</span>
  </section>

  <section class="connect" aria-label="Robot snapshot" ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); loadSnapshot(e.dataTransfer?.files) }}>
    <label class="button">Robot snapshot… <input type="file" accept=".json,application/json" hidden onchange={(e) => { const input = e.currentTarget as HTMLInputElement; loadSnapshot(input.files); input.value = '' }} /></label>
    <span class="status">
      {#if snapshotProblem}{snapshotProblem}
      {:else if !snapshot}For the CAN devices, CANcoder offsets, swerve ratio and current limits: once this page has a verdict, run <code>python3 tools/robot-snapshot.py</code> (robot on, not enabled), then choose or drop its <code>snapshot.json</code> here. Don't press Clear Faults or blink first.
      {:else}<code>{snapshot.fileName}</code>, taken {snapshot.takenAtLocal}: {snapshot.devices.length} devices{snapshot.stopped ? ' (stopped early: incomplete)' : ''}{checked ? (checked.snapshotUsed ? '. Used for this check.' : `. Not used: ${snapshotWhy}`) : ''}
        <button class="button" onclick={() => { snapshot = null; live?.setSnapshot(null) }}>Remove</button>{/if}
    </span>
  </section>

  <section class={`verdict v-${verdict.replace(' ', '-').toLowerCase()}`} aria-live="polite">
    <p class="big">{verdict}</p>
    <p>{why}</p>
    {#if unrun}<p class="unrun">{unrun}</p>{/if}
    {#if result?.state === 'settling'}<p class="small">Nothing is judged until {SETTLE_SECONDS} s after the robot code starts: start-up camera and time-sync alerts clear in that time.</p>{/if}
    {#if checked?.hoot}<p class="small">{checked.hoot.text}</p>{/if}
  </section>

  {#if checked}
    {#if decisive.length}
      <ol class="items" aria-label="Findings that decide GO or NO-GO">
        {#each decisive as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
      </ol>
    {/if}
    {#if stepItems.length}
      <ol class="items context-items" aria-label="Steps for a person: never changes the verdict">
        {#each stepItems as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
      </ol>
    {/if}
    {#if contextItems.length}
      <details class="inert">
        <summary>{contextItems.length} context {contextItems.length === 1 ? 'note' : 'notes'}: never {contextItems.length === 1 ? 'changes' : 'change'} the verdict</summary>
        <ol class="items context-items" aria-label="Context: never changes the verdict">
          {#each contextItems as item (item.finding.key + item.finding.title)}{@render itemRow(item)}{/each}
        </ol>
      </details>
    {/if}
    {#if checked.verdict.notChecked.length || checked.verdict.crashed.length}
      <details class="notchecked">
        <summary>Not checked or partly checked: {checked.verdict.notChecked.length + checked.verdict.crashed.length} of {totalChecks} checks</summary>
        <ul>
          {#each checked.verdict.notChecked as s (s.rule)}<li><code>{s.rule}</code>: {s.reason}</li>{/each}
          {#each checked.verdict.crashed as s (s.rule)}<li><code>{s.rule}</code> crashed: {s.reason}</li>{/each}
        </ul>
      </details>
    {/if}
  {/if}

  {#if status}
    <section class="onchecks" aria-label="The team's pit checklist">
      <h3>Pit checklist: battery, controllers, software</h3>
      <ul>
        {#each liveLines as l (l.line)}{@render checkLine(l)}{/each}
      </ul>
      <details class="inert">
        <summary>{inertLines.length} lines for a person or context</summary>
        <ul>
          {#each inertLines as l (l.line)}{@render checkLine(l)}{/each}
        </ul>
      </details>
      <p class="small">In the team's 2026 checklist order. A line is marked only from the check on screen now; "By eye" lines are for a person and never count toward GO. A merged line shows the worst of its checked parts, says how many were checked, and names each part that is not OK; it reads "Not checked" only when no part was.</p>
      {#if wanted.length}
        <details class="inert">
          <summary>{wanted.length} wanted checks: problems no check can see yet (context, never changes the verdict)</summary>
          <ul aria-label="Wanted checks: context, never changes the verdict">
            {#each wanted as w (w.id)}<li class="oc wanted"><span class="mark">Wanted</span><span class="line">{w.question}</span><span class="detail-text">{w.detail}</span></li>{/each}
          </ul>
        </details>
      {/if}
    </section>
  {/if}

  <CodeCheck robotSha={checked?.match.build.sha || null} robotDirty={!!checked && /uncommitted/i.test(checked.match.build.dirty)} suggest={status?.profile?.code} onchecked={useCode} />

  {#if status && status.state !== 'closed'}
    <details class="readings" open>
      <summary>Readings</summary>
      <dl>
        <dt>Connected to</dt><dd><code>{status.url}</code></dd>
        <dt>Topics announced / signals asked for</dt><dd>{status.topicsAnnounced} / {status.subscribed.length}</dd>
        <dt>Values received</dt><dd>{status.valuesReceived.toLocaleString()}</dd>
        <dt>Robot time</dt><dd>{fmt(status.robotTime)}{#if status.codeStart !== null} · code started at {fmt(status.codeStart)} (from the {status.codeStartFrom}){/if}</dd>
        <dt>Robot</dt><dd>{status.profile ? profileId(status.profile) : '—'}</dd>
        {#if checked}
          <dt>Battery now</dt><dd>{battery === null ? '—' : `${battery.toFixed(2)} V`}</dd>
          <dt>Controllers</dt><dd>{controllers.map((c, i) => `${i}: ${c}`).join(' · ') || '—'}</dd>
          <dt>Code</dt><dd><code>{checked.match.build.sha.slice(0, 7) || '?'}</code> on {checked.match.build.branch || '?'} · {checked.match.build.dirty || '?'}</dd>
          <dt>Checked stretch</dt><dd>{fmt(checked.start)} to {fmt(checked.end)}</dd>
        {/if}
      </dl>
      <button class="button" onclick={downloadReadings} title="Saves foresight-readings-….json: these readings, the verdict, and which signals the robot never sent">Download for Claude</button>
      <button class="button" onclick={async () => { saveProblem = (await reportView?.save()) ?? null }} title="Opens the print dialog: choose Save as PDF. Also saves a phone-sized card (PNG) to post in Slack with it.">Save for Slack</button>
      {#if saveProblem}<p class="small" role="alert">{saveProblem}</p>{/if}
    </details>
  {/if}
{/if}
</div>
<ForesightReport bind:this={reportView} {totalChecks} {status} {checked} {verdict} {why} {onchecks} {battery} {controllers} />

<style>
  .connect + .connect { margin-top: 0.5rem; }
  .connect { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: 8px; }
  .connect input { font: inherit; padding: 0.25rem 0.4rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .status { color: var(--muted); font-size: 0.85rem; flex: 1 1 18rem; }
  .button { padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .verdict { margin: 1rem 0; padding: 1.25rem 1rem; border-radius: 10px; text-align: center; border: 2px solid var(--border); }
  .big { font-size: clamp(2rem, 9vw, 4rem); font-weight: 800; margin: 0; letter-spacing: 0.02em; }
  .verdict p { margin: 0.25rem 0; }
  .small { font-size: 0.8rem; color: var(--muted); }
  .verdict .unrun { font-size: 1rem; color: var(--muted); }
  details > summary { min-height: 24px; box-sizing: border-box; }
  .v-go { border-color: var(--go, #188038); color: var(--go, #188038); }
  .v-no-go { border-color: var(--error); color: var(--error); }
  .v-not-checked { color: var(--muted); }
  .items { list-style: none; padding: 0; margin: 0; }
  .item { border-left: 4px solid var(--border); padding: 0.4rem 0.75rem; margin: 0 0 0.5rem; }
  .item.red { border-left-color: var(--error); }
  .item.amber { border-left-color: var(--warning); }
  .items.under { margin: 0.4rem 0 0; }
  .under .item { margin-bottom: 0; }
  .row { display: flex; gap: 0.6rem; align-items: baseline; width: 100%; text-align: left; border: none; background: none; color: var(--fg); font: inherit; cursor: pointer; padding: 0; }
  .chip { font-size: 0.75rem; font-weight: 700; white-space: nowrap; }
  .red .chip { color: var(--error); }
  .amber .chip { color: var(--warning); }
  .grey .chip { color: var(--muted); }
  .title { font-weight: 600; font-size: 1.1rem; }
  .action, .proof { margin: 0.15rem 0 0; font-size: 0.9rem; }
  .proof { color: var(--muted); font-size: 0.8rem; }
  .detail { font-size: 0.85rem; margin-top: 0.4rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; margin: 0.4rem 0; font-size: 0.85rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .notchecked, .readings { margin-top: 1rem; font-size: 0.85rem; }
  .onchecks { margin-top: 1rem; }
  .onchecks h3 { font-size: 1rem; margin: 0 0 0.4rem; }
  .onchecks ul { list-style: none; margin: 0; padding: 0; }
  .oc { display: grid; grid-template-columns: 6.5rem minmax(10rem, 1fr) 2fr; gap: 0.15rem 0.75rem; padding: 0.25rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; align-items: baseline; }
  .oc .mark { font-weight: 700; font-size: 0.8rem; }
  .oc.ok .mark { color: var(--muted); font-weight: 400; }
  .oc.not-checked .mark { color: var(--fg); }
  .inert { margin-top: 0.4rem; }
  .inert summary { color: var(--muted); font-size: 0.85rem; cursor: pointer; padding: 0.25rem 0; }
  .inert ul { list-style: none; margin: 0; padding: 0; }
  .context-items { margin-top: 0.75rem; }
  .oc.red .mark { color: var(--error); }
  .oc.amber .mark { color: var(--warning); }
  .oc.to-do .mark { color: var(--fg); }
  .oc.context .mark, .oc.by-eye .mark, .oc.wanted .mark { color: var(--muted); }
  .oc .detail-text { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  @media (max-width: 600px) { .oc { grid-template-columns: 5.5rem 1fr; } .oc .detail-text { grid-column: 2; } }
  .field { margin: 2rem 0; padding: 2rem 1rem; text-align: center; border: 3px solid var(--error); border-radius: 10px; color: var(--error); }
  .field .big { font-size: clamp(1.5rem, 6vw, 2.75rem); }
  @media (prefers-color-scheme: dark) { :global(:root:not([data-theme='light'])) { --go: #81c995; } }
</style>
