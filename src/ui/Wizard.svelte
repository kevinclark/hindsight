<!--
  The limits wizard: students run a supply-limit sweep on the robot, one card at a time. The tool never changes robot
  code or motor settings: each card says what to set and where; the student does it and drops the log in.
-->
<script lang="ts">
  import type { Analysis } from '../analyze.ts'
  import { analyzeFiles } from '../analyze.ts'
  import { offseason2026 } from '../profiles/2026-offseason.ts'
  import { checkStep, comparability, groupOf, newSession, parseSession, serializeSession, SESSION_FILE_NAME, sweepResult, type LimitsSession } from '../limits/session.ts'
  import { zeroingChecks } from '../limits/zeroing.ts'
  import { downloadText } from './download.ts'
  import Scatter from './Scatter.svelte'

  let { matches }: { matches: Analysis[] } = $props()
  const profile = offseason2026
  const sweepable = profile.motorGroups.filter((g) => g.spinUp)

  let session = $state<LimitsSession | null>(null)
  let groupName = $state(sweepable[0]?.name ?? '')
  let sweepText = $state('none, 60, 50, 40, 30')
  let problem = $state('')
  let busy = $state(-1)
  let batteryIds = $state<string[]>([])

  const group = $derived(session ? groupOf(profile, session) : profile.motorGroups.find((g) => g.name === groupName))
  const canIds = $derived(group?.motors.map((m) => m.canId).filter((x) => x !== undefined).join(', ') || 'each motor in the group')
  const result = $derived(session ? sweepResult(session, profile, matches.map((a) => a.match)) : null)
  const comparable = $derived(session ? comparability(session) : null)

  function start() {
    const sweep = sweepText.split(',').map((s) => s.trim()).map((s) => (/^(none|no|off)/i.test(s) ? null : Number(s)))
    if (sweep.some((s) => s !== null && !(s > 0))) { problem = 'Sweep: numbers in amps, comma-separated, "none" for no limit.'; return }
    session = newSession(profile, groupName, sweep)
    batteryIds = session.steps.map(() => '')
    problem = ''
  }

  async function loadSession(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    try {
      session = parseSession(await f.text())
      batteryIds = session.steps.map((s) => s.batteryId)
      problem = ''
    } catch (error) { problem = `${f.name}: ${error instanceof Error ? error.message : error}` }
  }

  async function check(index: number, files: FileList | null) {
    const f = files?.[0]
    if (!f || !session) return
    busy = index
    await new Promise((r) => setTimeout(r, 30))
    try {
      const { analyses, problems } = analyzeFiles([{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }])
      if (!analyses[0]) throw new Error(problems.join('; ') || 'not a .wpilog')
      session = checkStep(session, index, analyses[0].match, batteryIds[index] ?? '')
      problem = ''
    } catch (error) { problem = `${f.name}: ${error instanceof Error ? error.message : error}` }
    busy = -1
  }

  function save() {
    if (session) downloadText(SESSION_FILE_NAME, serializeSession({ ...session, steps: session.steps.map((s, i) => ({ ...s, batteryId: batteryIds[i] ?? s.batteryId })) }))
  }

  const label = (limitA: number | null) => (limitA === null ? 'no limit' : `${limitA} A`)
  const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')
  const zeroing = $derived(matches.flatMap((a) => zeroingChecks(a.match).map((z) => ({ ...z, file: a.match.fileName }))))
</script>

<p class="intro">
  The wizard walks you through finding a supply current limit by measuring it. Each card says what to do, where, and
  what "done" looks like. <strong>It never changes the robot code or the motors</strong>: you set things in Phoenix Tuner
  X, run the robot, and drop the log in. Save your progress to <code>{SESSION_FILE_NAME}</code>; the page can't save files by itself.
</p>
{#if problem}<p class="problem" role="alert">{problem}</p>{/if}

{#if !session}
  <section class="card">
    <h3>1. Pick the mechanism</h3>
    <label>Mechanism <select bind:value={groupName}>{#each sweepable as g (g.name)}<option value={g.name}>{g.name}</option>{/each}</select></label>
    {#if group}
      <p>Now: supply limit {group.limits.supplyA ?? '—'} A, <strong>{group.limits.supplyEnabled ? 'on' : 'switched off'}</strong>; stator limit {group.limits.statorA ?? '—'} A ({group.limits.statorEnabled ? 'on' : 'off'}). Set in <code>{group.limits.where}</code>.</p>
    {/if}
    <label>Sweep (A, "none" = no limit) <input bind:value={sweepText} size="28" /></label>
    <p class="why"><strong>Why:</strong> a supply limit trades spin-up time for battery voltage. Measuring a few values shows where it starts to cost real time: the "knee".</p>
    <details class="quiz"><summary>Check your understanding: why start with no limit?</summary><p>It's the baseline. Every other step is compared with it: "how much slower than with no limit?"</p></details>
    <div class="actions"><button onclick={start}>Start the sweep</button>
      <label class="file">or load a saved session <input type="file" accept=".json" onchange={(e) => loadSession((e.currentTarget as HTMLInputElement).files)} /></label></div>
  </section>
{:else}
  <div class="actions"><button onclick={save}>Save {SESSION_FILE_NAME}</button> <button class="link" onclick={() => (session = null)}>Start over</button></div>
  {#if comparable && !comparable.ok}
    <p class="warn" role="alert"><strong>These runs can't be compared fairly:</strong> {comparable.problems.join('; ')}. Re-run on the same charged battery, to the same setpoint.</p>
  {/if}

  {#each session.steps as step, i (i)}
    <section class="card" class:done={step.runs.length > 0}>
      <h3>{i + 2}. {session.group}: {label(step.limitA)}</h3>
      <div class="sub">
        <h4>Set it</h4>
        <p>Phoenix Tuner X → each motor ({canIds}) → Configs → Current Limits:
          {#if step.limitA === null}
            <code>SupplyCurrentLimitEnable = false</code> (the no-limit baseline; this also removes Phoenix's default 70 A supply limit, so only for this test).
          {:else}
            <code>SupplyCurrentLimit = {step.limitA}</code>, <code>SupplyCurrentLimitEnable = true</code>, and <strong><code>SupplyCurrentLowerTime = 0</code></strong>.
          {/if}
          Then Save, on <em>every</em> motor. This needs no robot code; it lasts until the code applies its own config at the next boot.</p>
        {#if step.limitA !== null}<p class="why"><strong>Why LowerTime = 0:</strong> by default, after 1 s at the limit Phoenix drops the cap to 40 A, which would turn any long run into a 40 A test.</p>{/if}
        <p class="unverified">Verify on the robot: the setting holds while the robot code runs, and applies the same way to the followers.</p>
      </div>
      <div class="sub">
        <h4>Run it</h4>
        <p>On a charged battery, run the real command (the shot spin-up to shot speed) <strong>3 times from a standstill</strong>. Wait until the wheel has stopped between runs (about 10 s: it takes more than 5 s to coast down). Then download the log with AdvantageScope.</p>
        <label>Battery label <input bind:value={batteryIds[i]} size="8" placeholder="B07" /></label>
        <p class="why"><strong>Why the same battery:</strong> a weaker battery sags more and spins up slower; then you'd be measuring the battery, not the limit.</p>
      </div>
      <div class="sub">
        <h4>Check it</h4>
        <label class="file">Drop or choose the log for this step <input type="file" accept=".wpilog" onchange={(e) => check(i, (e.currentTarget as HTMLInputElement).files)} /></label>
        {#if busy === i}<span class="busy">Reading…</span>{/if}
        {#if step.logFile}
          <p class="note">{step.logFile}: {step.runs.length} spin-up{step.runs.length === 1 ? '' : 's'} from standstill{step.runs.length < 3 ? ' (want 3: did the wheel stop between runs?)' : ''}.</p>
          {#if step.runs.length}
            <table>
              <thead><tr><th>run</th><th>time to setpoint</th><th>target</th><th>peak supply per motor</th><th>voltage dip</th><th>start</th><th>battery</th></tr></thead>
              <tbody>
                {#each step.runs as r, k (k)}
                  <tr><td>{k + 1}</td><td>{f2(r.timeToSetpoint)} s</td><td>{r.target.toFixed(1)}</td><td>{r.peakSupply.map((p) => p.amps.toFixed(0)).join(' / ')} A</td><td>{f2(r.dipVolts)} V</td><td>{f2(r.startVolts)} V</td><td>{r.batteryId ?? '—'}</td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#if step.took}
            {#if step.took.ok}
              <p class="ok">{step.took.motors.some((m) => m.verdict === 'held at the limit') ? 'The limit took effect' : 'Nothing went over the limit (the motors never needed this much, so this run can\'t show it holding)'}: {step.took.motors.map((m) => `${m.motor} ${m.verdict}`).join('; ')}.</p>
            {:else}
              {#each step.took.problems as p (p)}<p class="warn" role="alert">{p}</p>{/each}
            {/if}
          {/if}
        {/if}
        <details class="quiz"><summary>Check your understanding: why not judge the peak current?</summary><p>The limiter needs a few hundredths of a second to catch up, so the peak always overshoots. A limit that works holds the current at the limit; one that didn't save stays far over it for longer than 0.2 s.</p></details>
      </div>
    </section>
  {/each}

  {#if result}
    <section class="card">
      <h3>{session.steps.length + 2}. Result</h3>
      {#if result.points.length}
        <div class="plots">
          <Scatter xLabel="peak group current (A)" yLabel="spin-up (s)" points={result.points.map((p) => ({ x: p.peakGroupA, y: p.timeToSetpoint, label: label(p.limitA), highlight: p.limitA === result.recommended?.limitA }))} />
          <Scatter xLabel="peak group current (A)" yLabel="dip (V)" points={result.points.map((p) => ({ x: p.peakGroupA, y: p.dipVolts, label: label(p.limitA), highlight: p.limitA === result.recommended?.limitA }))} />
        </div>
        <label>Slowest acceptable spin-up: <input type="number" min="0" max="200" step="5" bind:value={session.slowerByPct} /> % slower than no limit</label>
      {/if}
      {#if result.leftOut.length}<p class="warn">Left out until re-run (the limit didn't take): {result.leftOut.map(label).join(', ')}.</p>{/if}
      {#if result.recommended}
        <p><strong>Recommended: {result.recommended.limitA} A</strong> — the lowest limit whose spin-up is within {session.slowerByPct} % of the {f2(result.recommended.baseline)} s with no limit.</p>
      {:else}
        <p class="note">No recommendation yet: check the no-limit step and at least one limit.</p>
      {/if}
      <p class="note">In the match logs loaded in Match review ({result.recovery.matches}): the wheel recovered from {result.recovery.shots} shot{result.recovery.shots === 1 ? '' : 's'} in {f2(result.recovery.median)} s (median). That's the match version of spin-up time.</p>
      {#if result.budget}
        <p class="note">Robot budget with {result.recommended?.limitA} A on the {session.group.toLowerCase()} (weakest fleet battery, worst moment of the first loaded match): {result.budget.scenarios.map((s) => `${s.name}: ${f2(s.volts)} V`).join(' · ')}. Goal: {result.budget.floor} V or more.</p>
      {/if}
      <div class="sub">
        <h4>The code change you write</h4>
        <label>SupplyCurrentLowerLimit <input type="number" bind:value={session.lowerLimitA} size="5" /> A</label>
        <label>SupplyCurrentLowerTime <input type="number" step="0.1" bind:value={session.lowerSeconds} size="5" /> s</label>
        <p><code>{result.codeChange}</code></p>
        <p class="why"><strong>Why you write it:</strong> the robot code is the team's. The wizard measured; you decide and change the line.</p>
      </div>
      <div class="sub">
        <h4>Final check</h4>
        <p>Deploy, reboot the robot, then in Tuner X read the limits back on CAN IDs {canIds} and confirm they match the code. The code doesn't check whether <code>apply()</code> succeeded, so a value from your sweep could survive a failed apply at boot.</p>
      </div>
    </section>
  {/if}
{/if}

<section class="card">
  <h3>Stator-limit tests</h3>
  <div class="sub locked">
    <h4>Drive wheel slip <span class="chip">waiting for Kevin to agree the procedure</span></h4>
    <p>The robot drives into a fixed wall on carpet while drive voltage ramps up (<code>VoltageOut</code>). Slip is where wheel velocity becomes non-zero and stator current drops (CTRE's criterion; odometry is wheel-based and can't see slip). Set the stator limit 10–15 % below the slip current.</p>
    <p>Safety: bumpers on, hold-to-run button, automatic stop at slip, ≤ 3 s per ramp, nobody within 2 m, motors cool between ramps, a mentor present. Our drive limits (120 A stator, 40 A supply) sit below CTRE's ~130 A slip example, so both are raised in Tuner X for the test only. The ramp command is yours to write.</p>
  </div>
  <div class="sub">
    <h4>Hard-stop zeroing (from match logs, no robot run)</h4>
    {#if zeroing.length === 0}
      <p class="note">Load match logs in Match review to check the zero thresholds.</p>
    {:else}
      {#each zeroing as z (z.file + z.mechanism)}
        <p>{z.file}: {z.mechanism} zero threshold {z.thresholdA} A vs stator limit {z.statorLimitA} A{z.thresholdAtLimit ? ' — equal, so the zero trips only on overshoot' : ''}.
          {#if z.zeros.length}Zeros: {z.zeros.map((x) => `${x.at.toFixed(1)} s, peak ${x.peakA.toFixed(0)} A, ${x.secondsAtThreshold.toFixed(2)} s at threshold`).join('; ')}.{/if}
          {#if z.thresholdAtLimit}Suggested: {z.suggestedThresholdA} A.{/if}</p>
      {/each}
    {/if}
    <details class="quiz"><summary>Check your understanding: why must the threshold be below the stator limit?</summary><p>The stator limit holds the current at the limit, so a threshold equal to it is only crossed when the limiter overshoots. A small change in how fast the limiter reacts would stop the zero from ever finishing.</p></details>
  </div>
</section>

<style>
  .intro, .why, .note { font-size: 0.85rem; color: var(--muted); max-width: 80ch; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin: 1rem 0; }
  .card.done { border-color: var(--series-3); }
  h3 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  h4 { font-size: 0.9rem; margin: 0.25rem 0; }
  .sub { border-top: 1px dashed var(--border); padding: 0.5rem 0; }
  .sub:first-of-type { border-top: none; }
  .unverified { font-size: 0.8rem; color: var(--warning); }
  .locked { opacity: 0.75; }
  .chip { font-size: 0.75rem; font-weight: normal; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--warning); color: var(--warning); }
  .quiz { font-size: 0.85rem; margin-top: 0.4rem; }
  .quiz summary { cursor: pointer; color: var(--focus); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0.5rem 0; }
  button { padding: 0.35rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  button.link { border: none; background: none; text-decoration: underline; color: var(--muted); }
  label { display: inline-flex; gap: 0.4rem; align-items: center; margin: 0.25rem 1rem 0.25rem 0; font-size: 0.9rem; flex-wrap: wrap; }
  label { max-width: 100%; }
  input[type='file'] { max-width: 100%; min-width: 0; }
  input, select { font: inherit; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 0.1rem 0.3rem; }
  table { border-collapse: collapse; font-size: 0.8rem; font-variant-numeric: tabular-nums; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: 0.15rem 0.9rem 0.15rem 0; white-space: nowrap; }
  thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  .ok { color: var(--series-3); }
  .warn { color: var(--warning); }
  .problem { color: var(--error); }
  .busy { color: var(--muted); }
  .plots { display: flex; flex-wrap: wrap; gap: 1rem; }
</style>
