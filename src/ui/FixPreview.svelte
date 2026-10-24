<!--
  A code finding's fix, shown as a preview (ADR 2): the unified diff, what it does not fix, how often this check has been
  marked "not a real problem", and two buttons, Copy and Save .patch. Hindsight never applies it: the student runs
  `git apply`, reads `git diff` and commits it themselves. Takes any finding that carries a `fix` (a CodeFinding from the
  code check); the Code panel uses it now, and the board's issue detail mounts it after both slices merge.
-->
<script lang="ts">
  import type { CodeFinding } from '../code/check/rule.ts'
  import { patchFileName } from '../code/check/fix-patch.ts'
  import { downloadText } from './download.ts'

  let { finding, sure = null, sameLine = false }: {
    finding: Pick<CodeFinding, 'rule'> & { fix?: { patch: string; doesNotFix: string } }
    /** The check's "How sure" line from the team's marks (triage/track-record.ts howSure); null or left out when no marks are in reach. */
    sure?: string | null
    /** Another finding's fix changes a line this one changes: only one of the two can be applied as it is. */
    sameLine?: boolean
  } = $props()

  const patch = $derived(finding.fix?.patch ?? '')
  const fileName = $derived(patchFileName(finding.rule))
  const notFixed = $derived((finding.fix?.doesNotFix ?? '').split('\n').filter(Boolean))
  /** Each line with what it is, so the colours are never the only cue (the +/- stays in the text). */
  const lines = $derived(patch.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').map((text) => ({
    text,
    kind: text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') ? 'head' : text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx',
  })))

  let copied = $state<'' | 'yes' | 'no'>('')
  async function copy() {
    try {
      await navigator.clipboard.writeText(patch)
      copied = 'yes'
    } catch {
      copied = copyBySelection(patch) ? 'yes' : 'no'
    }
    setTimeout(() => (copied = ''), 3000)
  }
  /** For a page the browser won't give the clipboard to (opened from a file, or without focus): select a hidden copy and copy it. */
  function copyBySelection(text: string): boolean {
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(box)
    box.select()
    try { return document.execCommand('copy') } catch { return false } finally { box.remove() }
  }
  const save = () => downloadText(fileName, patch, 'text/x-diff')
</script>

{#if finding.fix}
  <div class="fix" role="group" aria-label="Fix for this finding, a patch to read and apply yourself">
    <h5>A fix to read, not applied</h5>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrolling region must take focus to scroll by keyboard (WCAG 2.1.1) -->
    <pre class="diff" tabindex="0" aria-label="The patch">{#each lines as l, i (i)}<span class={l.kind}>{l.text}</span>{/each}</pre>
    {#if sameLine}<p class="same" role="note">Another finding's fix changes this same line: apply one, then run the check again.</p>{/if}
    <p><strong>What this does not fix:</strong></p>
    <ul>{#each notFixed as point (point)}<li>{point}</li>{/each}</ul>
    <p class="sure"><strong>How sure:</strong> {#if sure}{sure}.{:else}no marks on this check in reach here.{/if}</p>
    <p class="actions">
      <button onclick={copy}>Copy</button>
      <button onclick={save}>Save .patch</button>
      <span class="muted" role="status">{#if copied === 'yes'}Copied: paste it into a file in the robot folder and <code>git apply</code> it.{:else if copied === 'no'}The browser would not copy: select the diff above, or Save .patch.{/if}</span>
    </p>
    <ol class="steps" aria-label="How to apply it">
      <li>Save .patch (into Downloads, unless you choose another folder: then use that path below).</li>
      <li>In the robot folder: <code>git apply ~/Downloads/{fileName}</code> (Windows: <code>%USERPROFILE%\Downloads\{fileName}</code>).</li>
      <li>Read <code>git diff</code>, then <code>git add</code> and <code>git commit</code> yourself.</li>
    </ol>
    <p class="muted">Hindsight changes nothing in your code.</p>
  </div>
{/if}

<style>
  .fix { margin: 0.5rem 0 0.25rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; }
  h5 { font-size: 0.85rem; margin: 0 0 0.35rem; }
  .diff { margin: 0 0 0.4rem; padding: 0.4rem 0; overflow-x: auto; background: var(--hover); border-radius: 4px; font: 0.8rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .diff span { display: block; padding: 0 0.6rem; white-space: pre; }
  /* Light: dark enough on their own tints for 4.5:1 (add 5.3, del 5.6, hunk 5.9 on the diff's grey). */
  .diff { --add: #0d652d; --del: #a50e0e; --hunk: #0b57d0; }
  .diff .head { color: var(--muted); }
  .diff .hunk { color: var(--hunk); }
  .diff .add { color: var(--add); background: color-mix(in srgb, var(--add) 14%, transparent); }
  .diff .del { color: var(--del); background: color-mix(in srgb, var(--del) 14%, transparent); }
  @media screen and (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .diff { --add: var(--series-3); --del: var(--error); --hunk: var(--focus); }
  }
  ul, ol { margin: 0.2rem 0; padding-left: 1.3rem; font-size: 0.85rem; }
  li { margin: 0.15rem 0; }
  .same { padding: 0.25rem 0.5rem; border-left: 4px solid var(--warning); }
  p { font-size: 0.85rem; margin: 0.3rem 0; }
  .muted { color: var(--muted); }
  .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .actions button { padding: 0.25rem 0.7rem; min-height: 24px; border: 1px solid var(--border); border-radius: 6px; background: var(--hover); color: var(--fg); font: inherit; font-size: 0.85rem; cursor: pointer; }
</style>
