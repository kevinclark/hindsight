<script lang="ts">
  // The running job's progress (sync, download, robot pull, adding a folder): one bar over the whole job by bytes when
  // the sizes are known (by files when not, moving when neither is), the file now with its own bar, the time left once
  // the rate has settled, and a Stop that answers at once. NN/g progress indicators: a percent-done bar for anything over
  // ~10 s, say what is happening, and acknowledge a press within 0.1 s.
  import type { Progress } from '../hub/bridge.ts'
  import { untrack } from 'svelte'
  import { estimateLeft, formatRate, isArriving, noDataText, quietSince, rateOver, size, stepWaitText, type Sample } from './job-bar.ts'

  /** `onStop` absent: the work can't be stopped (signing in, saving), so no Stop is offered. */
  let { progress, onStop }: { progress: Progress; onStop?: () => void } = $props()

  // Shown as stopping the moment Stop is pressed; the app's own event follows.
  let pressed = $state(false)
  const stopping = $derived(!!progress.stopping || pressed)
  function stop() { pressed = true; onStop?.() }

  // Bytes over time for the time left, for this job only.
  let samples: Sample[] = []
  let forJob = ''
  const left = $derived.by(() => {
    if (progress.job !== forJob) { samples = []; forJob = progress.job }
    if (!progress.bytes) return ''
    samples = [...samples, { at: Date.now(), bytes: progress.bytes.done }].slice(-200)
    return estimateLeft(samples, progress.bytes.total)
  })

  // Speed and "no data": bytes of the file or job over time, and a once-a-second clock, because no progress events arrive
  // while nothing moves (which is exactly when the words are needed).
  let moves = $state.raw<Sample[]>([])
  let movesJob = ''
  $effect(() => {
    const bytes = progress.bytes?.done ?? progress.file?.done
    const job = progress.job
    untrack(() => {
      if (job !== movesJob) { moves = []; movesJob = job }
      if (bytes !== undefined) moves = [...moves, { at: Date.now(), bytes }].slice(-100)
    })
  })
  // When the current file and the current step began (their own clocks): "no data" and a step's "· 7 s" count from there at most.
  let fileStart = $state(Date.now())
  let stepStart = $state(Date.now())
  let lastFile = ''
  let lastStep = ''
  $effect(() => {
    const current = progress.current
    const step = progress.step ?? ''
    untrack(() => {
      if (current !== lastFile) { lastFile = current; fileStart = Date.now() }
      if (step !== lastStep) { lastStep = step; stepStart = Date.now() }
    })
  })
  let now = $state(Date.now())
  $effect(() => {
    const timer = setInterval(() => { now = Date.now() }, 1000)
    return () => clearInterval(timer)
  })
  // Only while a file is arriving (see isArriving): not a local file read with no byte count, nor one that is all in and being read here.
  const arriving = $derived(isArriving({ file: progress.file, transfer: progress.transfer, current: progress.current, stopping }))
  const quiet = $derived(arriving ? noDataText(quietSince(moves, now, fileStart)) : '')
  const stepWait = $derived(progress.step ? stepWaitText(now - stepStart) : '')
  const speed = $derived.by(() => {
    if (!arriving || quiet) return ''
    const r = rateOver(moves)
    return r === null ? '' : formatRate(r)
  })

  const value = $derived(progress.bytes?.total ? progress.bytes.done / progress.bytes.total : progress.total ? progress.done / progress.total : null)
  const what = $derived(progress.step || (progress.total ? `${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : ''))
  const amounts = $derived([
    progress.bytes?.total ? `${size(progress.bytes.done)} of ${size(progress.bytes.total)}` : '',
    value !== null ? `${Math.floor(value * 100)}%` : '',
    speed,
    stopping ? '' : left,
  ].filter(Boolean).join(' · '))
  // Only once bytes move: a local file is read first (no bytes) and copied after, so an empty bar would look stuck.
  const file = $derived(progress.file && progress.file.total > 0 && progress.file.done > 0 && progress.current ? progress.file : null)
</script>

<!-- Only the head is a live region: the amounts below change several times a second. -->
<div class="job-bar" class:stopping>
  <div class="head">
    <span class="what" role="status"><strong>{progress.job}</strong>{#if what}{' '}· {what}{stepWait}{/if}{#if stopping}{' '}· stopping{/if}</span>
    {#if stopping}
      <span class="stopping-note">Stops once the current step finishes. What is done is kept.</span>
    {:else if onStop}
      <button type="button" class="stop" onclick={stop}>Stop</button>
    {/if}
  </div>
  <progress max="1" value={value ?? undefined} aria-label="{progress.job}, all of it"></progress>
  {#if amounts || quiet}<p class="meta">{amounts}{#if quiet}{#if amounts}{' · '}{/if}<span class="warn">{quiet}</span>{/if}</p>{/if}
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
  .warn { color: var(--warning); font-weight: 600; }
  .file code { font-size: 0.8rem; }
</style>
