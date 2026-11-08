/**
 * The job log: `<userData>/logs/jobs.log`, one timestamped line per thing a job does (start, each step, each file's start
 * and end, each stall, reconnect and resume, errors, the finish), so a pull that went wrong can be read afterwards. Byte
 * progress is never logged. At 5 MB the file moves to `jobs.1.log` (one old file kept). Node only: tests drive it directly.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { JobLogSink } from '../src/hub/jobs.ts'

export const ROTATE_BYTES = 5 * 1024 * 1024

/** ISO time with the zone's offset: 2026-11-08T14:03:09.120-08:00. */
export function isoWithOffset(ms: number): string {
  const d = new Date(ms)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const p = (n: number, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0')
  const local = new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, -1)
  return `${local}${sign}${p(offset / 60)}:${p(offset % 60)}`
}

export class JobLog implements JobLogSink {
  readonly path: string
  private readonly old: string
  private chain: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly rotateAt: number

  constructor(dir: string, options: { now?: () => number; rotateAt?: number } = {}) {
    this.path = join(dir, 'jobs.log')
    this.old = join(dir, 'jobs.1.log')
    this.now = options.now ?? Date.now
    this.rotateAt = options.rotateAt ?? ROTATE_BYTES
  }

  /** Append a line (in order; never throws: a log that can't be written must not stop a pull). */
  line(text: string): void {
    const stamped = `${isoWithOffset(this.now())} ${text.replace(/\r?\n/g, ' ')}\n`
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const size = (await stat(this.path).catch(() => null))?.size ?? 0
        if (size >= this.rotateAt) await rename(this.path, this.old)
        await appendFile(this.path, stamped)
      } catch { /* see above */ }
    })
  }

  /** The file exists (empty if no job has written yet), so showing it in the file manager selects it. */
  async ensure(): Promise<string> {
    await this.flush()
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, '')
    return this.path
  }

  /** Resolves once every line given so far is on disk. */
  flush(): Promise<void> { return this.chain }
}
