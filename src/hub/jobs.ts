/**
 * One job at a time (an import, a sync, a download, a re-read): they share the library's manifest and the user's attention.
 * Remembers the latest progress so a page that loads mid-job (or never started it) can show the same bar.
 */
export interface JobProgress { job: string; done: number; total: number; current: string }
export interface JobHandle { cancelled: boolean }

export type Work<T> = (job: JobHandle, progress: (done: number, total: number, current: string) => void) => Promise<T>

export class JobRunner {
  private running: { handle: JobHandle; name: string; latest: JobProgress | null } | null = null

  /** `send` gets every progress event, and `null` when the job ends, so a page can clear its bar. */
  async run<T>(
    name: string,
    work: Work<T>,
    send: (p: JobProgress | null) => void = () => {},
  ): Promise<T> {
    if (this.running) throw new Error('Another job is running. Wait for it or stop it first.')
    const mine: { handle: JobHandle; name: string; latest: JobProgress | null } = (this.running = { handle: { cancelled: false }, name, latest: null })
    try {
      return await work(mine.handle, (done, total, current) => { mine.latest = { job: name, done, total, current }; send(mine.latest) })
    } finally {
      this.running = null
      send(null)
    }
  }

  cancel(): void { if (this.running) this.running.handle.cancelled = true }

  /** The running job's latest progress (its name with nothing done before the first event), or null when none runs. */
  current(): JobProgress | null { return this.running ? this.running.latest ?? { job: this.running.name, done: 0, total: 0, current: '' } : null }
}
