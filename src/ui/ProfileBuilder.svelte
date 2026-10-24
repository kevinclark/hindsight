<!--
  Robot profile builder: drop match logs (and optionally a robot snapshot and the robot code: a folder, or a public
  GitHub repo at the log's commit) and get a draft
  robot profile the student confirms, keeps in this browser, or saves as profile.json. Everything stays in this page.
  The draft says where each value came from (the code, the log, the snapshot, a guess from names, or the student);
  what no file can show is listed under "Not checked with this profile".
-->
<script lang="ts">
  import { openWpilog, type WpilogFile } from '../readers/wpilog.ts'
  import { busLabel, parseSnapshot, SNAPSHOT_SCHEMA, type Snapshot, type Device } from '../snapshot/snapshot.ts'
  import { allMotors, applySnapshot, carryConfirmations, draftProfile, draftWarnings, NOT_INFERRED, refreshLimits, setDevice, type DraftLog } from '../builder/draft.ts'
  import { parseProfileJson, type GroupJson, type MotorJson, type ProfileJson } from '../builder/json.ts'
  import { forgetProfile, keepProfile, keptId, keptProfiles } from '../builder/store.ts'
  import { codeHead, codeHints, hintsAt, shaWarning, siteLabel, type CodeFile, type CodeHints } from '../builder/code-hints.ts'
  import { loadJavaInPage } from '../code/check/browser-java.ts'
  import { browserGitHub, gitRepoOfFiles } from '../code/browser-code-folder.ts'
  import { parseGitHub } from '../code/github.ts'
  import { PROFILES } from '../profiles/index.ts'
  import { formatOfSignals } from '../profiles/formats.ts'
  import { deviceLabel } from '../builder/snapshot.ts'
  import { lowerLimitOff } from '../limits/limits-report.ts'
  import { downloadText } from './download.ts'
  import { changed } from './kept-profiles.svelte.ts'
  import { teamNow } from './team-setting.svelte.ts'
  import { builderStart } from './builder-start.ts'

  let logs = $state.raw<DraftLog[]>([])
  let snapshot = $state.raw<Snapshot | null>(null)
  let hints = $state.raw<CodeHints | null>(null)
  /** Where the hints came from: "code folder", or "owner/repo (GitHub)". */
  let hintsFrom = $state('code folder')
  let askingGitHub = $state(false)
  let githubSpec = $state('')
  /** The repo a library log was linked to (start()): used by "Use GitHub" when no built-in profile names the codebase. */
  let linkedRepo = ''
  /** The draft was opened by start(): its logs are linked to this team's sources, so the draft gets the team. */
  let stampTeam = false
  /** Bumped by start(): a load or code read still running from before (another robot's log, its Read) is dropped when it ends. */
  let generation = 0
  let json = $state<ProfileJson | null>(null)
  let notUsed = $state<{ key: string; why: string }[]>([])
  let guessedSignals = $state<{ signal: string; key: string; alternatives: string[] }[]>([])
  let seenLimits = $state<string[]>([])
  let problems = $state<string[]>([])
  let busy = $state(false)
  let dragging = $state(false)
  let keptNote = $state('')
  let draftNotes = $state<string[]>([])
  /** The profile on screen was opened (kept list, profile.json), not drafted from the logs. */
  let openedProfile = $state(false)
  let kept = $state<ProfileJson[]>(keptProfiles())
  // The keptId of the kept profile being edited (opened from the list, or kept since): keeping replaces it, renamed or not.
  let keptAs = $state<string | null>(null)

  const SOURCE_WORDS: Record<string, string> = { log: 'log', snapshot: 'snapshot', code: 'code', you: 'you', 'code hint': 'code hint' }
  /** Why a group is one, as the builder shows it: the code, or a guess from the log's key names. */
  const GROUP_WORDS: Record<string, string> = { code: 'the code', swerve: 'guess: swerve names', 'one array': 'guess: one array key', 'leader/follower': 'guess: leader and follower names', you: 'you' }
  const talons = $derived((snapshot?.devices ?? []).filter((d) => d.isMotor))
  // Notes on the files (logs left out, what the code says the log lacks) come from the draft; the rest follow the student's edits.
  const warnings = $derived(json ? [...draftNotes, ...draftWarnings(json.motorGroups)] : [])
  const shaProblem = $derived(hints && json?.code ? shaWarning(hints, json.code.sha) : null)
  const framework = $derived(json?.signals ? formatOfSignals(json.signals)?.name ?? 'unknown' : 'unknown')
  // Computed on a copy: refreshLimits fills in the group's limits, and here only its reason for leaving them out is wanted.
  const limitProblems = $derived.by(() => {
    const out = new Map<string, string>()
    if (!snapshot || !json) return out
    const copy = $state.snapshot(json) as ProfileJson
    for (const [g, why] of refreshLimits(copy, snapshot)) out.set(g.name, why)
    return out
  })
  const hintIds = $derived([...new Set((hints?.sites ?? []).map((s) => s.id).filter((id): id is number => id !== null))].sort((a, b) => a - b))

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'robot'
  const startsWithWpilog = (b: Uint8Array) => b.length >= 6 && String.fromCharCode(...b.subarray(0, 6)) === 'WPILOG'

  /** A profile.json that leaves out the game or code fields still shows editable ones. `fromKept`: opened from the kept list. */
  function open(p: ProfileJson, fromKept = false) {
    keptAs = fromKept ? keptId(p) : null
    linkedRepo = ''; stampTeam = false
    const copy = structuredClone($state.snapshot(p)) as ProfileJson
    copy.game ??= { name: '', autoSeconds: 15, teleopSeconds: 135 }
    copy.code ??= { repo: '', branch: '', sha: '' }
    json = copy
    draftNotes = []
    notUsed = []
    guessedSignals = []
    openedProfile = true
    seenLimits = []
    keptNote = ''
  }

  function redraft() {
    if (logs.length === 0) return
    const d = draftProfile({ logs, snapshot: snapshot ?? undefined, hints: hints ?? undefined })
    if (stampTeam && d.json.team === undefined && teamNow() !== null) d.json.team = teamNow()!
    // A draft from a log knows the codebase and commit, not the repo: a library log's code link does.
    if (linkedRepo && d.json.code && !d.json.code.repo) d.json.code.repo = linkedRepo
    // Another log was dropped: keep what the student already confirmed.
    if (json) { carryConfirmations($state.snapshot(json) as ProfileJson, d.json); if (snapshot) refreshLimits(d.json, snapshot) }
    json = d.json
    draftNotes = d.notes
    openedProfile = false
    notUsed = d.notUsed
    guessedSignals = d.guessed
    seenLimits = d.limits
    keptNote = ''
  }

  async function load(list: FileList | File[] | null, fromLink = false) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    if (!fromLink) { linkedRepo = ''; stampTeam = false }
    // Two drops add up (a second log joins the draft); a start() in between replaces both.
    const mine = generation
    busy = true
    await new Promise((r) => setTimeout(r, 30))
    if (mine !== generation) return
    const found: string[] = []
    let newLogs = false, newSnapshot = false
    let profile: ProfileJson | null = null
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        if (mine !== generation) return
        if (startsWithWpilog(bytes)) {
          const log: WpilogFile = openWpilog(bytes)
          logs = [...logs.filter((l) => l.fileName !== f.name), { log, fileName: f.name }]
          newLogs = true
          continue
        }
        const text = new TextDecoder().decode(bytes)
        let raw: unknown
        try { raw = JSON.parse(text) } catch { throw new Error(`${f.name} is not a .wpilog or a JSON file`) }
        if ((raw as { schema?: unknown } | null)?.schema === SNAPSHOT_SCHEMA) {
          snapshot = parseSnapshot(text, f.name)
          newSnapshot = true
        } else {
          profile = parseProfileJson(text, f.name)
        }
      } catch (error) {
        found.push(error instanceof Error ? error.message : `${f.name}: ${error}`)
      }
    }
    problems = found
    if (profile) {
      open(profile)
      if (newSnapshot && snapshot && json) applySnapshot(json, snapshot)
    } else if (newLogs) redraft()
    else if (newSnapshot && snapshot && json) applySnapshot(json, snapshot)
    busy = false
  }

  async function loadCode(list: FileList | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    const mine = generation
    busy = true
    const read: CodeFile[] = []
    for (const f of files) {
      const path = f.webkitRelativePath || f.name
      if (path.endsWith('.java')) read.push({ path, text: await f.text() })
    }
    try {
      await loadJavaInPage()
      const head = await codeHead(gitRepoOfFiles(files))
      if (mine !== generation) return
      useHints(codeHints(read, head), 'code folder')
      problems = []
    } catch (error) {
      if (mine !== generation) return
      problems = [error instanceof Error ? error.message : String(error)]
    }
    busy = false
  }

  /**
   * Starts a draft from library logs with "Use GitHub" open and filled in (`owner/repo@ref`, from a log's code link). The
   * student presses Read: the GitHub requests stay theirs to start.
   */
  export async function start(files: File[], spec: string): Promise<void> {
    const s = builderStart(spec)
    generation++
    logs = []; snapshot = null; hints = null; json = null
    ;({ keptAs, openedProfile, keptNote, problems, draftNotes, notUsed, guessedSignals, seenLimits, hintsFrom, githubSpec, askingGitHub, linkedRepo, stampTeam } = s)
    await load(files, true)
  }

  /**
   * Pre-fills "Use GitHub" with the profile's repo at the commit the log ran (else its branch). A draft from logs knows
   * the codebase and commit but not the repo: then the repo of a built-in profile for the same codebase.
   */
  function askGitHub() {
    const realRepo = (repo?: string) => !!repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
    const sameCodebase = PROFILES.find((p) => p.codebase === json?.codebase && realRepo(p.code.repo))
    const repo = realRepo(json?.code?.repo) ? json?.code?.repo : sameCodebase?.code.repo ?? (linkedRepo || undefined)
    const sha = /^[0-9a-f]{7,40}$/i.test(json?.code?.sha ?? '') ? json!.code!.sha.slice(0, 7) : ''
    if (repo) githubSpec = `${repo}@${sha || json?.code?.branch || sameCodebase?.code.branch || 'main'}`
    askingGitHub = !askingGitHub
  }

  /** The code at a branch or commit of a public GitHub repo: every Java file's text at that commit. */
  async function loadGitHub(spec: string) {
    const parsed = parseGitHub(spec)
    if (!parsed?.ref) { problems = [`"${spec}" isn't a GitHub repo and branch: write it as owner/repo@branch.`]; return }
    const mine = generation
    busy = true
    try {
      await loadJavaInPage()
      const found = await hintsAt(browserGitHub(parsed.repo), parsed.ref)
      if (mine !== generation) return
      useHints(found, `${parsed.repo} (GitHub)`)
      askingGitHub = false
      problems = []
    } catch (error) {
      if (mine !== generation) return
      problems = [error instanceof Error ? error.message : String(error)]
    }
    busy = false
  }

  /** The code: its CAN ID hints label the choices, and a draft from logs is drafted again with what the code says. */
  function useHints(found: CodeHints, from: string) {
    hints = found
    hintsFrom = from
    // A profile opened from the kept list or a file is the student's: label its choices, never draft over it.
    if (logs.length && !openedProfile) redraft()
    else if (json) json.builtFrom = { ...json.builtFrom, at: json.builtFrom?.at ?? new Date().toISOString(), code: found.sha ?? 'unknown commit' }
  }

  const groupOf = (m: MotorJson) => json?.motorGroups.find((g) => g.motors.includes(m))
  const deviceOf = (m: MotorJson): Device | undefined => (m.canId === undefined ? undefined : talons.find((d) => d.id === m.canId && (m.bus === undefined || d.bus === m.bus)))
  const sitesFor = (id: number) => (hints?.sites ?? []).filter((s) => s.id === id)
  const withSites = (id: number) => { const s = sitesFor(id); return s.length ? ` · ${s.map(siteLabel).join(', ')}` : '' }

  function pickDevice(motor: MotorJson, value: string) {
    if (!json) return
    if (value === '') { setDevice(json, snapshot, motor, null); return }
    if (snapshot) {
      const d = talons.find((x) => `${x.bus}|${x.id}` === value)
      if (d) setDevice(json, snapshot, motor, d)
      return
    }
    // No snapshot: a number from the code, with no bus known.
    motor.canId = Number(value.split('|')[1]); delete motor.bus; motor.canIdFrom = 'code hint'
  }

  function pickKind(motor: MotorJson, kind: string) {
    if (!motor.current || (kind !== 'supply' && kind !== 'stator')) return
    // Never replace a key the log already names as supply or stator.
    if ((kind === 'supply' && motor.supplyCurrent) || (kind === 'stator' && motor.statorCurrent)) return
    if (kind === 'supply') motor.supplyCurrent = motor.current; else motor.statorCurrent = motor.current
    delete motor.current
    motor.kindFrom = 'you'
  }

  function moveMotor(motor: MotorJson, to: string) {
    if (!json || !to) return
    const from = groupOf(motor)
    if (!from) return
    let target: GroupJson | undefined
    if (to === 'new') {
      let name = motor.name, n = 2
      while (json.motorGroups.some((g) => g.name.trim().toLowerCase() === name.toLowerCase())) name = `${motor.name} ${n++}`
      json.motorGroups.push({ name, groupedBy: 'you', motors: [] })
      target = json.motorGroups[json.motorGroups.length - 1]
    } else target = json.motorGroups[Number(to)]
    if (!target || target === from) return
    from.motors = from.motors.filter((m) => m !== motor)
    target.motors.push(motor)
    json.motorGroups = json.motorGroups.filter((g) => g.motors.length > 0)
    if (snapshot) refreshLimits(json, snapshot)
  }

  const confirmLoop = (g: GroupJson) => { delete g.sameLoopSuggested }
  const limitText = (g: GroupJson) => {
    const l = g.limits
    if (!l) return null
    const part = (what: string, a?: number, on?: boolean) => (a === undefined && on === undefined ? null : `${what} ${a === undefined ? '?' : `${a} A`} ${on === false ? 'off' : on ? 'on' : ''}`.trim())
    const lower = l.supplyEnabled === false || (l.supplyLowerA === undefined && l.supplyLowerSeconds === undefined) ? null
      : lowerLimitOff(l) ? 'no supply lower limit (time 0)' : `supply lower ${l.supplyLowerA ?? '?'} A after ${l.supplyLowerSeconds ?? '?'} s`
    const nums = [part('supply', l.supplyA, l.supplyEnabled), lower, part('stator', l.statorA, l.statorEnabled)].filter(Boolean).join(', ')
    return `${l.where}${nums ? `: ${nums}` : ''}`
  }

  function keep() {
    if (!json) return
    const now = $state.snapshot(json) as ProfileJson
    const replaced = keptAs && keptAs !== keptId(now) && kept.some((p) => keptId(p) === keptAs) ? kept.find((p) => keptId(p) === keptAs)!.name : null
    if (keepProfile(now, keptAs)) {
      keptNote = replaced ? `kept, in place of "${replaced}"` : 'kept'
      keptAs = keptId(now)
    } else keptNote = "this browser didn't keep it: save the file"
    kept = keptProfiles()
    changed()
  }
  function save() {
    if (!json) return
    downloadText(`${slug(json.name)}.profile.json`, JSON.stringify($state.snapshot(json), null, 1), 'application/json')
  }
  function forget(p: ProfileJson) {
    forgetProfile(keptId(p))
    if (keptAs === keptId(p)) keptAs = null
    kept = keptProfiles()
    changed()
  }
</script>

<svelte:window ondragover={(e) => { e.preventDefault() }} />

<p class="intro">
  Drop your match logs (<code>.wpilog</code>, several is better), your robot snapshot (<code>snapshot.json</code>), or a saved <code>profile.json</code>
  to draft a robot profile you can check and keep. Optionally choose your robot-code folder (only its <code>.java</code> files and
  <code>.git</code> branch files are read) or a public GitHub repo at the log's commit: the code fills in CAN IDs, which current is
  supply and which stator, groups and current limits, each marked "from code" for you to confirm. Files never leave the computer.
</p>

<section class="drop" class:dragging aria-label="Drop files" aria-busy={busy}
  ondragover={(e) => { e.preventDefault(); dragging = true }} ondragleave={() => (dragging = false)}
  ondrop={(e) => { e.preventDefault(); e.stopPropagation(); dragging = false; load(e.dataTransfer?.files ?? null) }}>
  <label class="button">
    <input type="file" multiple accept=".wpilog,.json" aria-label="Logs, snapshot or profile files" onchange={(e) => { const input = e.currentTarget as HTMLInputElement; load(input.files); input.value = '' }} />
    Choose files…
  </label>
  <label class="button">
    <input type="file" webkitdirectory multiple aria-label="Robot code folder" onchange={(e) => { const input = e.currentTarget as HTMLInputElement; loadCode(input.files); input.value = '' }} />
    Robot code folder (optional)…
  </label>
  <button class="button" aria-expanded={askingGitHub} onclick={askGitHub}>Use GitHub…</button>
  {#if busy}<span class="muted">Reading…</span>{/if}
</section>

{#if askingGitHub}
  <form class="github" onsubmit={(e) => { e.preventDefault(); loadGitHub(githubSpec) }}
    title="Every .java file at that branch's newest commit (or the commit you name) is read from GitHub. Public repos only; GitHub allows 60 lookups an hour per network without signing in, and this uses 1 or 2.">
    <label>GitHub repo and branch <input data-builder-github bind:value={githubSpec} placeholder="owner/repo@branch" size="40" spellcheck="false" autocomplete="off" /></label>
    <button class="button" type="submit">Read</button>
  </form>
{/if}

{#each problems as p (p)}<p class="problem" role="alert">{p}</p>{/each}

<div class="loaded">
  {#each logs as l (l.fileName)}<span class="chip">{l.fileName}</span>{/each}
  {#if snapshot}<span class="chip">{snapshot.fileName} · {snapshot.devices.filter((d) => d.isMotor).length} Talon FX</span>{/if}
  {#if hints}<span class="chip">{hintsFrom}: {hints.sites.length} CAN ID hint{hints.sites.length === 1 ? '' : 's'}{hints.sha ? ` · ${hints.branch ?? 'detached'} ${hints.sha.slice(0, 7)}` : ''}</span>{/if}
</div>
{#if hints}{#each hints.notes as n (n)}<p class="note">{n}</p>{/each}{/if}

{#if json}
  {@const game = json.game!}
  {@const code = json.code!}
  <section class="head">
    <h2>Robot profile</h2>
    <p class="row">
      <label>Robot name <input type="text" bind:value={json.name} /></label>
      <span class="meta">Codebase <code>{json.codebase || '—'}</code> · {code.branch || 'no branch'} <code>{code.sha ? code.sha.slice(0, 7) : '—'}</code> · looks like {framework} logging</span>
    </p>
    <p class="row">
      <label>Auto <input type="number" min="0" step="1" class="num" bind:value={game.autoSeconds} /> s</label>
      <label>teleop <input type="number" min="0" step="1" class="num" bind:value={game.teleopSeconds} /> s</label>
      <span class="meta">{game.name ? `${game.name}: confirm` : 'confirm'}</span>
    </p>
    {#each warnings as w (w)}<p class="warn">{w}</p>{/each}
    {#if shaProblem}<p class="warn">{shaProblem}</p>{/if}
  </section>

  <section class="motors">
    <h3>Motors</h3>
    {#if !snapshot}<p class="note">Drop a robot snapshot to pick each motor's Talon FX and read its current limits from the robot{hintIds.length ? '; for now the CAN IDs come from the code folder' : ''}.</p>{/if}
    {#each json.motorGroups as g (g)}
      <section class="group" data-group={g.name}>
        <h4>
          <label>Group <input type="text" bind:value={g.name} /></label>
        </h4>
        {#if g.motors.length > 1 && (g.groupFromCode || GROUP_WORDS[g.groupedBy ?? ''])}
          <p class="meta" data-grouped>Grouped by {g.groupFromCode ? 'the code' : GROUP_WORDS[g.groupedBy!]}{g.groupFromCode && g.groupedBy !== 'code' && GROUP_WORDS[g.groupedBy ?? ''] ? ` (and ${GROUP_WORDS[g.groupedBy!].replace('guess: ', 'the ')})` : ''}</p>
        {/if}
        <p class="row">
          <label class="check"><input type="checkbox" bind:checked={g.sameLoop} onchange={() => confirmLoop(g)} /> these motors run one control loop (leader + followers)</label>
          {#if g.sameLoop && g.sameLoopSuggested}<span class="suggested">suggested from the {g.followerFromCode ? 'code (a follower)' : 'names'}: confirm</span>{/if}
        </p>
        <p class="meta limits-line">
          Limits:
          {#if limitText(g)}{limitText(g)}{#if g.limitsFromCode}<small class="tag">from code: confirm</small>{/if}
          {:else if limitProblems.get(g.name)}<span class="warn">{limitProblems.get(g.name)}</span>
          {:else}<span class="warn">not known{g.limitsWhy ? ` (${g.limitsWhy})` : ''}: drop a robot snapshot</span>{/if}
        </p>
        <div class="wrap">
          <table class="list">
            <thead><tr><th>motor</th><th>log path</th><th>current keys</th><th>CAN ID</th><th>move</th></tr></thead>
            <tbody>
              {#each g.motors as motor (motor)}
                {@const dev = deviceOf(motor)}
                <tr data-motor={motor.logPath ?? motor.name}>
                  <td><input type="text" aria-label="Name of {motor.logPath ?? motor.name}" bind:value={motor.name} /></td>
                  <td><code>{motor.logPath ?? '—'}</code></td>
                  <td>
                    {#if motor.supplyCurrent}<div>supply <code>{motor.supplyCurrent}</code></div>{/if}
                    {#if motor.statorCurrent}<div>stator <code>{motor.statorCurrent}</code></div>{/if}
                    {#if motor.current}
                      <div><code>{motor.current}</code>
                        <select data-kind aria-label="Is {motor.current} supply or stator current?" value="" onchange={(e) => pickKind(motor, (e.currentTarget as HTMLSelectElement).value)}>
                          <option value="">supply or stator?</option>
                          <option value="supply">supply</option>
                          <option value="stator">stator</option>
                        </select>
                      </div>
                    {/if}
                    {#if !motor.supplyCurrent && !motor.statorCurrent && !motor.current}<span class="muted">none</span>{/if}
                    {#if motor.kindFrom}<small class="tag" data-kind-from>supply or stator: from {SOURCE_WORDS[motor.kindFrom]}</small>{/if}
                  </td>
                  <td>
                    <select data-canid aria-label="CAN ID of {motor.name}" onchange={(e) => pickDevice(motor, (e.currentTarget as HTMLSelectElement).value)}>
                      <option value="" selected={motor.canId === undefined}>—</option>
                      {#if snapshot}
                        {#each talons as d (d.key)}
                          <option value={`${d.bus}|${d.id}`} selected={dev === d}>{deviceLabel(d)}{withSites(d.id)}</option>
                        {/each}
                        {#if motor.canId !== undefined && !dev}<option value={`${motor.bus ?? '?'}|${motor.canId}`} selected>{motor.canId}{motor.bus !== undefined ? ` on the ${busLabel(motor.bus)}` : ''} (not in this snapshot)</option>{/if}
                      {:else}
                        {#each hintIds as id (id)}
                          <option value={`|${id}`} selected={motor.canId === id}>{id}{withSites(id)}</option>
                        {/each}
                        {#if motor.canId !== undefined && !hintIds.includes(motor.canId)}<option value={`|${motor.canId}`} selected>{motor.canId}</option>{/if}
                      {/if}
                    </select>
                    {#if motor.canId !== undefined && motor.canIdFrom}<small class="tag">from {SOURCE_WORDS[motor.canIdFrom] ?? motor.canIdFrom}</small>{/if}
                  </td>
                  <td>
                    <select aria-label="Move {motor.name} to a group" value="" onchange={(e) => { const s = e.currentTarget as HTMLSelectElement; moveMotor(motor, s.value); s.value = '' }}>
                      <option value="">move to group…</option>
                      {#each json.motorGroups as other, i (other)}{#if other !== g}<option value={String(i)}>{other.name}</option>{/if}{/each}
                      <option value="new">new group</option>
                    </select>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/each}
    {#if allMotors(json).length === 0}<p class="note">No motors in this profile.</p>{/if}
  </section>

  {#if guessedSignals.length}
    <section class="guessed">
      <h3>Signals picked by their shape: confirm</h3>
      <ul>
        {#each guessedSignals as g (g.signal)}<li data-guessed={g.signal}><strong>{g.signal}</strong>: <code>{g.key}</code><small class="tag">guess</small>{#if g.alternatives.length}<span class="muted"> (also seen: {#each g.alternatives as a, i (a)}{i ? ', ' : ''}<code>{a}</code>{/each})</span>{/if}</li>{/each}
      </ul>
    </section>
  {/if}

  {#if notUsed.length || seenLimits.length}
    <section class="not-used">
      <h3>Seen, not used</h3>
      <ul>
        {#each notUsed as n (n.key)}<li><code>{n.key}</code>: {n.why}</li>{/each}
        {#each seenLimits as l (l)}<li>{l}</li>{/each}
      </ul>
    </section>
  {/if}
{/if}

<section class="not-checked">
  <h3>Not checked with this profile</h3>
  <p class="note">A profile built from files alone can't feed these rules; they stay "not checked" until someone adds them by hand.</p>
  <ul>
    {#each NOT_INFERRED as n (n.what)}<li><strong>{n.what}</strong>{n.rules.length ? ': ' : ''}{#each n.rules as r, i (r)}{i ? ', ' : ''}<code>{r}</code>{/each}</li>{/each}
  </ul>
</section>

{#if json}
  <section class="actions">
    <button class="button" onclick={keep}>Keep in this browser</button>
    <button class="button" onclick={save}>Save profile.json</button>
    {#if keptNote}<span class="muted" role="status">{keptNote}</span>{/if}
  </section>
{/if}

{#if kept.length}
  <section class="kept">
    <h3>Kept in this browser</h3>
    <ul>
      {#each kept as p (keptId(p))}
        <li data-kept={keptId(p)}>{p.name} <small class="muted">{p.code?.branch || 'any branch'} · {p.motorGroups.reduce((n, g) => n + g.motors.length, 0)} motors</small>
          <button class="link" onclick={() => open(p, true)} aria-label="Open {keptId(p)}">open</button>
          <button class="link" onclick={() => forget(p)} aria-label="Forget {keptId(p)}">forget</button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .intro, .note, .meta { font-size: 0.85rem; color: var(--muted); max-width: 85ch; }
  .meta { margin: 0.15rem 0 0; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
  .drop { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.9rem 1rem; border: 1.5px dashed var(--border); border-radius: 8px; }
  .drop.dragging { border-color: var(--focus); background: var(--hover); }
  .button { display: inline-block; padding: 0.4rem 0.9rem; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; cursor: pointer; }
  .button:hover { border-color: var(--muted); }
  .button input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .button:focus-within { outline: 2px solid var(--focus); }
  .github { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0.5rem 0; }
  .github input { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; max-width: 100%; }
  .problem { color: var(--error); font-size: 0.85rem; }
  .loaded { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .chip { display: inline-block; font-size: 0.75rem; padding: 0.05rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .head { margin-top: 1rem; }
  h2 { font-size: 1.2rem; margin: 0 0 0.25rem; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.25rem; }
  h4 { font-size: 0.95rem; margin: 0.5rem 0 0.1rem; }
  .row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 1rem; margin: 0.3rem 0; font-size: 0.85rem; }
  .warn { color: var(--warning); font-size: 0.85rem; max-width: 85ch; margin: 0.3rem 0; }
  .suggested { color: var(--warning); font-size: 0.8rem; }
  .group { margin-top: 1rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; }
  .check { display: inline-flex; gap: 0.4rem; align-items: center; }
  .limits-line { margin-bottom: 0.4rem; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.8rem; }
  .list th, .list td { text-align: left; padding: 0.2rem 0.9rem 0.2rem 0; vertical-align: top; }
  .list thead th { color: var(--muted); font-weight: normal; border-bottom: 1px solid var(--border); }
  .tag { color: var(--muted); margin-left: 0.4rem; white-space: nowrap; }
  input[type='text'], input[type='number'], select { font: inherit; font-size: 0.8rem; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; max-width: 100%; }
  input[type='text'] { padding: 0.15rem 0.3rem; }
  .num { width: 4.5rem; }
  select[data-canid] { width: 22ch; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 1.5rem; }
  .link { border: none; background: none; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; padding: 0 0.3rem; }
  li { font-size: 0.85rem; margin-bottom: 0.2rem; max-width: 85ch; }
</style>
