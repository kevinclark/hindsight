/**
 * One job at a time (an import, a sync, a download, a re-read): they share the library's manifest and the user's attention.
 * Remembers the latest progress so a page that loads mid-job (or never started it) can show the same bar.
 */
export interface Amount { done: number; total: number }
export interface JobProgress {
  job: string
  /** Files done of the files to do (0 of 0 before a count is known). */
  done: number
  total: number
  /** The file being worked on, or ''. */
  current: string
  /** What is happening when there is no count yet (connecting, listing), or absent. */
  step?: string
  /** Bytes over the whole job, when its files' sizes are known. */
  bytes?: Amount
  /** Bytes of the current file. */
  file?: Amount
  /** The user pressed Stop: the job is finishing the piece it is on. */
  stopping?: boolean
  /** The current file comes over a network (the robot, Drive): bytes not arriving is worth saying. A local folder's has no byte count while it is read. */
  transfer?: boolean
}
export interface JobHandle {
  cancelled: boolean
  /** Adds a line to the job log (electron/job-log.ts); does nothing when no log is kept. Byte progress is never logged. */
  log: (line: string) => void
}
/** Where a job's lines go: the app's `jobs.log`. */
export interface JobLogSink { line(text: string): void }
/** What a job adds to its count: a step in words, the whole job's bytes, the current file's bytes. */
export type ProgressMore = Pick<JobProgress, 'step' | 'bytes' | 'file' | 'transfer'>
export type ProgressFn = (done: number, total: number, current: string, more?: ProgressMore) => void

export type Work<T> = (job: JobHandle, progress: ProgressFn) => Promise<T>

/**
 * Bytes over a job of files, for the bar and its time left. A file counts only once its bytes move: one skipped without
 * a transfer (already there, copied inside Drive, known from the last pull) leaves the total instead of jumping the count,
 * so the rate is of real transfer.
 */
export function fileMeter(onProgress: ProgressFn | undefined, sizes: number[]) {
  const bytes = { done: 0, total: sizes.reduce((n, s) => n + s, 0) }
  return {
    /** The file `index` of `count` starts: `at(sent)` reports its bytes; `end()` once it is through, whatever happened. */
    start(index: number, count: number, name: string, size: number, transfer = false) {
      let moved = false
      let last = 0
      const report = (sent: number, step?: string) => {
        if (sent > 0) moved = true
        last = sent
        onProgress?.(index, count, name, { bytes: { done: bytes.done + sent, total: bytes.total }, file: { done: sent, total: size }, ...(transfer ? { transfer } : {}), ...(step ? { step } : {}) })
      }
      const at = (sent: number) => report(sent)
      at(0)
      /** A step in words for this file (the robot stopped sending; reconnecting), keeping its bytes: the bar does not fall back to 0. */
      const step = (words: string) => report(last, words)
      return { at, step, end: () => { if (moved) bytes.done += size; else bytes.total -= size } }
    },
  }
}

/** Least gap (ms) between two progress events that differ only in bytes: a byte count can move many times a second. */
export const BYTES_EVERY_MS = 150

interface Running { handle: JobHandle; name: string; latest: JobProgress | null; send: (p: JobProgress | null) => void }

export class JobRunner {
  /** The job that finished last: its report, or the words of its error. Kept so a page that reloaded can still show it. */
  lastFinished: { job: string; report?: unknown; error?: string; at: number } | null = null
  private running: Running | null = null

  private readonly now: () => number
  private readonly log: JobLogSink | null
  private readonly version: string
  constructor(now: () => number = Date.now, log: JobLogSink | null = null, version = 'unknown') { this.now = now; this.log = log; this.version = version }

  /** `send` gets every progress event, and `null` when the job ends, so a page can clear its bar. */
  async run<T>(
    name: string,
    work: Work<T>,
    send: (p: JobProgress | null) => void = () => {},
  ): Promise<T> {
    if (this.running) throw new Error('Another job is running. Wait for it or stop it first.')
    const log = this.log
    const mine: Running = (this.running = { handle: { cancelled: false, log: (line) => log?.line(line) }, name, latest: null, send })
    let sentAt = -Infinity
    let lastStep: string | undefined
    log?.line(`job start: ${name} (Hindsight ${this.version})`)
    try {
      const report = await work(mine.handle, (done, total, current, more = {}) => {
        const before = mine.latest
        mine.latest = { job: name, done, total, current, ...more, ...(mine.handle.cancelled ? { stopping: true } : {}) }
        if (more.step !== lastStep) { lastStep = more.step; if (more.step) log?.line(`step: ${more.step}`) }
        // A new file, count or step goes at once; a byte count alone waits its turn.
        const bytesOnly = before !== null && before.done === done && before.total === total && before.current === current && before.step === more.step
        if (bytesOnly && this.now() - sentAt < BYTES_EVERY_MS) return
        sentAt = this.now()
        send(mine.latest)
      })
      this.lastFinished = { job: name, report, at: Date.now() }
      log?.line(`job finish: ${name}: ${summarize(report)}`)
      return report
    } catch (e) {
      this.lastFinished = { job: name, error: e instanceof Error ? e.message : String(e), at: Date.now() }
      log?.line(`error: ${this.lastFinished.error}`)
      log?.line(`job finish: ${name}: failed${mine.handle.cancelled ? ' (stopped)' : ''}`)
      throw e
    } finally {
      this.running = null
      send(null)
    }
  }

  /** Ask the running job to stop, and tell the page at once: the job itself stops at its next piece. */
  cancel(): void {
    const r = this.running
    if (!r || r.handle.cancelled) return
    r.handle.cancelled = true
    r.latest = { ...progressOf(r), stopping: true }
    r.send(r.latest)
  }

  /** The running job's latest progress (its name with nothing done before the first event), or null when none runs. */
  current(): JobProgress | null { return this.running ? progressOf(this.running) : null }
}

const progressOf = (r: Running): JobProgress =>
  r.latest ?? { job: r.name, done: 0, total: 0, current: '', ...(r.handle.cancelled ? { stopping: true } : {}) }

/** A report in one line for the job log: each count, and the length of each list; a robot result's own words. */
export function summarize(report: unknown): string {
  if (typeof report !== 'object' || report === null) return String(report ?? 'done')
  const r = report as Record<string, unknown>
  if (typeof r.refused === 'string') return `refused: ${r.refused}`
  if (typeof r.report === 'object' && r.report !== null) return summarize(r.report)
  const bits = Object.entries(r).flatMap(([k, v]) => (typeof v === 'number' ? [`${k} ${v}`] : Array.isArray(v) ? [`${k} ${v.length}`] : typeof v === 'boolean' && v && k !== 'stopped' ? [k] : []))
  if (typeof r.lostLink === 'string') bits.push(`lostLink: ${r.lostLink}`)
  return `${r.stopped ? 'stopped; ' : ''}${bits.join(', ')}`
}
