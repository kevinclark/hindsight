<script lang="ts">
  // The running job's progress (sync, download, robot pull, adding a folder): one bar over the whole job by bytes when
  // the sizes are known (by files when not, moving when neither is), the file now with its own bar, the time left once
  // the rate has settled, and a Stop that answers at once. NN/g progress indicators: a percent-done bar for anything over
  // ~10 s, say what is happening, and acknowledge a press within 0.1 s.
  import type { Progress } from '../hub/bridge.ts'
  import { estimateLeft, type Sample } from './job-bar.ts'

  let { progress, onStop }: { progress: Progress; onStop: () => void } = $props()

  const size = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(n < 10 * 2 ** 20 ? 1 : 0)} MB`)

  // Bytes over time for the time left, for this job only.
  let samples: Sample[] = []
  let forJob = ''
  const left = $derived.by(() => {
    if (progress.job !== forJob) { samples = []; forJob = progress.job }
    if (!progress.bytes) return ''
    samples = [...samples, { at: Date.now(), bytes: progress.bytes.done }].slice(-200)
    return estimateLeft(samples, progress.bytes.total)
  })

  const value = $derived(progress.bytes?.total ? progress.bytes.done / progress.bytes.total : progress.total ? progress.done / progress.total : null)
  const what = $derived(progress.step || (progress.total ? `${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ''))
  const amounts = $derived([
    progress.bytes?.total ? `${size(progress.bytes.done)} of ${size(progress.bytes.total)}` : '',
    value !== null ? `${Math.floor(value * 100)}%` : '',
    progress.stopping ? '' : left,
  ].filter(Boolean).join(' · '))
  // Only once bytes move: a local file is read first (no bytes) and copied after, so an empty bar would look stuck.
  const file = $derived(progress.file && progress.file.total > 0 && progress.file.done > 0 && progress.current ? progress.file : null)
</script>

<div class="job-bar" class:stopping={progress.stopping} role="status" aria-live="polite">
  <div class="head">
    <span class="what"><strong>{progress.job}</strong>{#if what}{' '}· {what}{/if}</span>
    {#if progress.stopping}
      <span class="stopping-note">Stopping after the piece it is on (a few seconds). What is done is kept.</span>
    {:else}
      <button type="button" class="stop" onclick={onStop}>Stop</button>
    {/if}
  </div>
  <progress max="1" value={value ?? undefined} aria-label="{progress.job}, all of it"></progress>
  {#if amounts}<p class="meta">{amounts}</p>{/if}
  {#if file}
    <p class="meta file"><code>{progress.current}</code>{' '}<progress class="small" max={file.total} value={file.done} aria-label="This file"></progress>{' '}{size(file.done)} of {size(file.total)}</p>
  {:else if progress.current}
    <p class="meta file"><code>{progress.current}</code></p>
  {/if}
</div>

<style>
  .job-bar { flex-basis: 100%; display: grid; gap: 0.25rem; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; }
  .what { flex: 1 1 auto; overflow-wrap: anywhere; }
  .stop { margin-left: auto; }
  .stopping-note { margin-left: auto; color: var(--muted); font-size: 0.85rem; }
  progress { width: 100%; height: 0.6rem; accent-color: var(--focus); }
  progress.small { width: 8rem; height: 0.45rem; vertical-align: middle; }
  .stopping progress { opacity: 0.5; }
  .meta { color: var(--muted); font-size: 0.85rem; margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .file code { font-size: 0.8rem; }
</style>
