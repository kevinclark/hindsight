<!--
  The printed Foresight report: one page, hidden on screen. GO / NO-GO / NOT CHECKED large with the reason, stamped
  with the connection state and the time the readings were taken (a verdict that was withdrawn prints as NOT CHECKED,
  never as GO), then what to fix, what to look at, the pit checklist marks and the readings. Printing is a browser
  action: nothing here touches the robot connection or its field lock (nt4-client.ts).
-->
<script lang="ts">
  import type { LiveStatus } from '../foresight/live.ts'
  import type { ForesightResult } from '../foresight/engine.ts'
  import { ASSISTED_RULES, type MarkedLine } from '../foresight/onchecks.ts'
  import { profileId } from '../profiles/index.ts'
  import { buildCard, type Card } from '../report/card.ts'
  import { saveForSlack } from '../report/card-png.ts'
  import { fileStamp, foresightBuild, foresightCard, stamp, type ForesightReportInput } from '../report/foresight-model.ts'
  import { keyNumber } from '../report/review-model.ts'
  import { VERSION } from '../version.ts'

  let { status, checked, verdict, why, onchecks, battery, controllers }: {
    status: LiveStatus | null
    checked: Extract<ForesightResult, { state: 'checked' }> | null
    verdict: 'GO' | 'NO-GO' | 'NOT CHECKED'
    why: string
    onchecks: MarkedLine[]
    battery: number | null
    controllers: string[]
  } = $props()

  // The screen updates about once a second; the time of the latest update is the time the readings were taken.
  let readAt = $state(new Date())
  $effect.pre(() => { void status; void verdict; readAt = new Date() })

  const input = $derived<ForesightReportInput>({
    verdict, why, state: status?.state ?? 'not connected', message: status?.message ?? 'not connected', url: status?.url ?? null, readAt,
    robot: status?.profile ? profileId(status.profile) : null, items: checked?.verdict.items ?? [], onchecks, battery, controllers,
    build: checked?.match.build ?? null, notChecked: [...(checked?.verdict.notChecked ?? []), ...(checked?.verdict.crashed ?? [])],
  })
  const card = $derived<Card>(buildCard(foresightCard(input)))
  const build = $derived(foresightBuild(input))
  const reds = $derived(input.items.filter((i) => i.level === 'red'))
  const ambers = $derived(input.items.filter((i) => i.level === 'amber'))
  // Grey items that ask a person to do something (hold a tag up to a camera) are steps, not context.
  const steps = $derived(input.items.filter((i) => i.level === 'grey' && ASSISTED_RULES.has(i.finding.rule)))
  const greys = $derived(input.items.filter((i) => i.level === 'grey' && !ASSISTED_RULES.has(i.finding.rule)))
  // Lines the tool can never judge are listed by name under the table, not as rows.
  const liveLines = $derived(onchecks.filter((l) => l.state !== 'by eye' && l.state !== 'not yet'))
  const byEyeLines = $derived(onchecks.filter((l) => l.state === 'by eye'))
  const notYetLines = $derived(onchecks.filter((l) => l.state === 'not yet'))
  const MARK = { ok: 'OK', red: 'Fix', amber: 'Look', 'to do': 'Do', context: 'Context', 'not checked': 'Not checked', 'by eye': 'By eye', 'not yet': 'Not yet' } as const

  /** Print as PDF (the title names the file), then save the phone card. */
  export async function save(): Promise<string | null> {
    try { return await saveForSlack(`foresight-${fileStamp(readAt)}.report`, `foresight-${fileStamp(readAt)}.card.png`, card) } catch (error) { return `Save for Slack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // For the command-line checks (scripts/chrome-foresight-report-check.ts): the card as the page would save it.
  $effect(() => {
    const api = (window as unknown as { hindsight?: Record<string, unknown> }).hindsight
    if (api) api.foresightCard = () => card
  })
</script>

<article class="print-only report" aria-hidden="true">
  <header>
    <h1>Foresight pit check</h1>
  </header>

  <section class={`verdict v-${verdict.replace(' ', '-').toLowerCase()}`}>
    <p class="big">{verdict}</p>
    <p class="why">{why}</p>
  </section>

  <p class="meta">Read {stamp(readAt)} · connection: {input.state}{input.url ? ` (${input.url})` : ''} · {input.message}</p>
  <p class="meta">{input.robot ?? 'robot not identified'} · Hindsight {VERSION}</p>

  {#if build}<p class={`build ${build.uncommitted ? 'dirty' : ''}`}><strong>Code:</strong> {build.text}</p>{/if}

  {#if reds.length}
    <h2>Fix before the field ({reds.length})</h2>
    <ul class="items">{#each reds as i (i.finding.key)}<li class="red"><p class="title"><span class="sev red">Fix</span> {i.finding.title}</p><p class="do"><strong>Do:</strong> {i.action}</p><p class="small">{i.finding.rule} · {keyNumber(i.finding).label}: {keyNumber(i.finding).value}</p></li>{/each}</ul>
  {/if}
  {#if ambers.length}
    <h2>Look at ({ambers.length})</h2>
    <ul class="items">{#each ambers as i (i.finding.key)}<li class="amber"><p class="title"><span class="sev amber">Look</span> {i.finding.title}</p><p class="do"><strong>Do:</strong> {i.action}</p></li>{/each}</ul>
  {/if}
  {#if steps.length}
    <p class="small"><strong>To do:</strong> {steps.map((i) => i.finding.title).join(' · ')}</p>
  {/if}
  {#if greys.length}
    <p class="small"><strong>Context:</strong> {greys.map((i) => i.finding.title).join(' · ')}</p>
  {/if}

  <h2>Pit checklist</h2>
  <table>
    <tbody>
      {#each liveLines as l (l.line)}
        <tr class={l.state.replace(' ', '-')}><th scope="row">{l.line}</th><td class="mark">{MARK[l.state]}</td><td class="d">{l.detail}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if byEyeLines.length}<p class="small"><strong>By eye (a person checks):</strong> {byEyeLines.map((l) => l.line).join(' · ')}</p>{/if}
  {#if notYetLines.length}<p class="small"><strong>Not built yet:</strong> {notYetLines.map((l) => l.line).join(' · ')}</p>{/if}

  <h2>Readings</h2>
  <p>Battery {battery === null ? '—' : `${battery.toFixed(2)} V`} · Controllers {controllers.map((c, i) => `${i}: ${c}`).join(' · ') || '—'}</p>
  {#if input.notChecked.length}
    <p class="small"><strong>Not checked or partly checked ({input.notChecked.length}):</strong> {input.notChecked.map((s) => s.rule).join(', ')}</p>
  {/if}
  <p class="small">"By eye" lines are for a person and never count toward GO. Pit and queue only, over a tether.</p>
</article>

<style>
  .print-only { display: none; }
  @media print { .print-only { display: block; font-size: 9.5pt; line-height: 1.3; color: var(--fg); } }
  h1 { font-size: 15pt; margin: 0; }
  h2 { font-size: 10.5pt; margin: 0.6rem 0 0.2rem; padding-bottom: 0.1rem; border-bottom: 1px solid var(--border); }
  p { margin: 0.12rem 0; }
  .meta, .small { color: var(--muted); font-size: 8.5pt; overflow-wrap: anywhere; }
  .verdict { margin: 0.7rem 0 0.4rem; padding: 0.7rem 1rem; border: 3px solid var(--border); text-align: center; break-inside: avoid; }
  .big { font-size: 48pt; font-weight: 800; line-height: 1.05; margin: 0; letter-spacing: 0.02em; }
  .why { font-size: 12pt; margin: 0.2rem 0 0; }
  .v-go { border-color: var(--go); color: var(--go); }
  .v-no-go { border-color: var(--error); color: var(--error); }
  .v-not-checked { color: var(--muted); }
  .build.dirty { color: var(--warning); font-weight: 600; }
  .items { list-style: none; margin: 0; padding: 0; }
  .items li { padding: 0.2rem 0 0.2rem 0.5rem; border-left: 4px solid var(--border); margin-bottom: 0.3rem; break-inside: avoid; }
  .items li.red { border-left-color: var(--error); }
  .items li.amber { border-left-color: var(--warning); }
  .title { font-weight: 700; font-size: 10.5pt; }
  .sev { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.03em; margin-right: 0.3rem; }
  .sev.red { color: var(--error); }
  .sev.amber { color: var(--warning); }
  table { border-collapse: collapse; width: 100%; font-size: 8.5pt; }
  th { vertical-align: top; text-align: left; font-weight: normal; padding: 0.08rem 0.5rem 0.08rem 0; border-bottom: 1px solid var(--border); width: 38%; }
  td { padding: 0.08rem 0.4rem 0.08rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  td.mark { font-weight: 700; width: 5rem; white-space: nowrap; }
  td.d { color: var(--muted); font-size: 8pt; }
  tr.ok .mark { color: var(--muted); }
  tr.red .mark { color: var(--error); }
  tr.amber .mark { color: var(--warning); }
  tr.not-checked .mark, tr.not-yet .mark, tr.context .mark, tr.by-eye .mark { color: var(--muted); }
</style>
