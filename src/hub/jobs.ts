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
}
export interface JobHandle { cancelled: boolean }
/** What a job adds to its count: a step in words, the whole job's bytes, the current file's bytes. */
export type ProgressMore = Pick<JobProgress, 'step' | 'bytes' | 'file'>
export type ProgressFn = (done: number, total: number, current: string, more?: ProgressMore) => void

export type Work<T> = (job: JobHandle, progress: ProgressFn) => Promise<T>

/** Least gap (ms) between two progress events that differ only in bytes: a byte count can move many times a second. */
export const BYTES_EVERY_MS = 150

interface Running { handle: JobHandle; name: string; latest: JobProgress | null; send: (p: JobProgress | null) => void }

export class JobRunner {
  /** The job that finished last: its report, or the words of its error. Kept so a page that reloaded can still show it. */
  lastFinished: { job: string; report?: unknown; error?: string; at: number } | null = null
  private running: Running | null = null

  private readonly now: () => number
  constructor(now: () => number = Date.now) { this.now = now }

  /** `send` gets every progress event, and `null` when the job ends, so a page can clear its bar. */
  async run<T>(
    name: string,
    work: Work<T>,
    send: (p: JobProgress | null) => void = () => {},
  ): Promise<T> {
    if (this.running) throw new Error('Another job is running. Wait for it or stop it first.')
    const mine: Running = (this.running = { handle: { cancelled: false }, name, latest: null, send })
    let sentAt = -Infinity
    try {
      const report = await work(mine.handle, (done, total, current, more = {}) => {
        const before = mine.latest
        mine.latest = { job: name, done, total, current, ...more, ...(mine.handle.cancelled ? { stopping: true } : {}) }
        // A new file, count or step goes at once; a byte count alone waits its turn.
        const bytesOnly = before !== null && before.done === done && before.total === total && before.current === current && before.step === more.step
        if (bytesOnly && this.now() - sentAt < BYTES_EVERY_MS) return
        sentAt = this.now()
        send(mine.latest)
      })
      this.lastFinished = { job: name, report, at: Date.now() }
      return report
    } catch (e) {
      this.lastFinished = { job: name, error: e instanceof Error ? e.message : String(e), at: Date.now() }
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
