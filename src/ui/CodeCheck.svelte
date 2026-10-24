<!--
  Foresight's "Code" panel: the code checks (src/code/check/) run over the robot-code folder, on the commit the robot
  reports when the folder has it. Context for the software lead: it never changes GO and never joins the verdict.
  Read only: the folder's files are never changed or uploaded.
-->
<script lang="ts">
  import CodeFolderControl from './CodeFolderControl.svelte'
  import FixPreview from './FixPreview.svelte'
  import type { RobotProfile } from '../profiles/types.ts'
  import { codeFolder } from './code-folder.svelte.ts'
  import { CODE_RULES, checkFolder, type FolderCheck } from '../code/check/index.ts'
  import { loadJavaInPage } from '../code/check/browser-java.ts'
  import { fileName } from '../code/check/java.ts'

  let { robotSha, robotDirty, suggest, onchecked, sure }: {
    robotSha: string | null; robotDirty: boolean; suggest?: RobotProfile['code']; onchecked?: (check: FolderCheck | null) => void
    /** A check's "How sure" line from the team's marks (null when it has none), shown beside its fix. Left out where no history is in reach. */
    sure?: (rule: string) => string | null
  } = $props()

  let result = $state.raw<FolderCheck | null>(null)
  let problem = $state<string | null>(null)
  let running = $state(false)
  let latest = 0

  // Again whenever the folder or the robot's commit changes; an older run that finishes late is dropped.
  $effect(() => {
    const code = codeFolder.current
    const sha = robotSha
    void codeFolder.version
    if (!code) {
      latest++                                  // a run still going when the folder was forgotten is dropped too
      result = null
      return
    }
    const run = ++latest
    running = true
    loadJavaInPage()
      .then(async () => checkFolder(code.repo, sha, await codeFolder.head()))
      .then((r) => { if (run === latest) { result = r; problem = null } }, (error) => { if (run === latest) { result = null; problem = error instanceof Error ? error.message : String(error) } })
      .finally(() => { if (run === latest) running = false })
  })

  // Foresight checks the robot snapshot against the settings this read (snapshot/code-settings).
  $effect(() => onchecked?.(result))

  /** Findings grouped by check, in CODE_RULES order (the ones that cost a match most directly first). */
  const groups = $derived(CODE_RULES.map((rule) => (result?.report.findings ?? []).filter((f) => f.rule === rule.id)).filter((g) => g.length > 0))
  const short = (sha: string) => sha.slice(0, 7)
</script>

<section class="code-check" aria-label="Code check: context for the software lead, never changes the verdict">
  <h3>Code <span class="muted">· context for the software lead, never changes GO</span></h3>
  <CodeFolderControl {suggest} />
  {#if !codeFolder.current}
    <p class="muted">Choose the robot-code folder (a git clone) or a GitHub repo to check its Java for bugs the robot can't show: a gear ratio that lost its remainder, a flag nothing sets.</p>
  {:else if running && !result}
    <p class="muted">Checking the code…</p>
  {:else if problem}
    <p class="code-problem" role="alert">Couldn't check the code: {problem}</p>
  {:else if result}
    <p class="code-commit">
      {#if result.ranOn === 'robot'}Checked <code>{short(result.commit)}</code>, the commit the robot runs
      {:else}Checked {result.branch ? `${result.branch} at ` : ''}<code>{short(result.commit)}</code>{/if}
      ({codeFolder.current?.repo.where ?? 'the robot code'}): {result.files} Java files, {result.report.findings.length} findings.
      {#if result.why}<br /><span class="muted">Not the robot's commit: {result.why}.</span>{/if}
      {#if robotDirty}<br /><span class="muted">The robot's code had uncommitted changes: those aren't checked.</span>{/if}
      <br /><span class="muted">Uncommitted edits aren't checked: only commits are.</span>
    </p>
    {#each groups as findings (findings[0].rule)}
      <h4>{findings[0].title} <span class="muted">({findings.length})</span></h4>
      <ul class="code-findings">
        {#each findings as f (f.file + f.line + f.message)}
          <li class="code-finding">
            <details>
              <summary><code>{fileName(f.file)}:{f.line}</code> {f.message}</summary>
              <p>{f.meaning}</p>
              <dl>{#each Object.entries(f.evidence) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}<dt>file</dt><dd><code>{f.file}</code></dd></dl>
              <p><strong>Next:</strong> {f.nextStep} <span class="muted">({f.rule})</span></p>
              <FixPreview finding={f} sure={sure?.(f.rule) ?? null} />
            </details>
          </li>
        {/each}
      </ul>
    {/each}
    {#if result.report.notJudged.length}
      <details class="code-unjudged">
        <summary class="muted">{result.report.notJudged.length} places a check couldn't judge (a value it can't work out): never findings</summary>
        <ul>{#each result.report.notJudged as n (n.rule + n.file + n.line + n.why)}<li><code>{fileName(n.file)}:{n.line}</code> {n.why} <span class="muted">({n.rule})</span></li>{/each}</ul>
      </details>
    {/if}
    {#each result.report.crashed as c (c.rule)}<p class="code-problem">{c.rule} couldn't run (a bug in the check, not your code): {c.why}</p>{/each}
  {/if}
</section>

<style>
  .code-check { margin-top: 1rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: 8px; }
  .code-check h3 { font-size: 1rem; margin: 0 0 0.5rem; }
  .code-check h4 { font-size: 0.9rem; margin: 0.75rem 0 0.25rem; color: var(--warning); }
  .muted { color: var(--muted); font-weight: 400; font-size: 0.85rem; }
  .code-commit { font-size: 0.9rem; margin: 0.5rem 0; }
  .code-findings, .code-unjudged ul { list-style: none; margin: 0; padding: 0; }
  .code-finding { border-left: 4px solid var(--warning); padding: 0.25rem 0.75rem; margin: 0 0 0.35rem; font-size: 0.9rem; }
  .code-finding summary { cursor: pointer; min-height: 24px; }
  .code-finding p, .code-finding dl { font-size: 0.85rem; margin: 0.3rem 0; }
  .code-finding dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem; }
  .code-finding dt { color: var(--muted); }
  .code-finding dd { margin: 0; overflow-wrap: anywhere; }
  .code-unjudged { margin-top: 0.5rem; font-size: 0.85rem; }
  .code-unjudged summary { cursor: pointer; min-height: 24px; }
  .code-problem { color: var(--error); }
</style>
