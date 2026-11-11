/**
 * The one rule every transfer follows (the robot over SFTP, Google Drive over HTTP): a link that goes quiet never errors by
 * itself, so a transfer that sees nothing move for STALL_MS fails with words, and Stop is looked for a few times a second
 * even while nothing arrives. No `node:` import here, so the phone build can bundle it with the Drive reader.
 */
import { Stopped } from './adapter.ts'

/** Nothing moved for this long fails a transfer (and a request that does not answer). */
export const STALL_MS = 15_000
/** A transfer is tried this many times in all (the first and two resumes) before the job stops with words. */
export const TRIES = 3

/** The far end stopped answering: no data for the stall time, or the connection closed. */
export class Stalled extends Error {
  constructor(message: string) { super(message) }
}

export interface Watchdog {
  /** Something moved: the stall clock starts again, `graceMs` later than usual (a wait whose bytes can't be seen). Also looks for Stop. */
  alive(graceMs?: number): void
  /** The transfer is over: no more calls. */
  done(): void
}

/**
 * Calls `onStop` once Stop is asked (`cancelled` turns true) or `onStall` once nothing has moved for `stallMs`, whichever
 * comes first, and then nothing more. Checked on every `alive()` and a few times a second in between.
 */
export function watchdog(o: { stallMs: number; cancelled?: () => boolean; onStall: () => void; onStop: () => void }): Watchdog {
  let deadline = Date.now() + o.stallMs
  let over = false
  const fire = (f: () => void) => { if (over) return; over = true; clearInterval(timer); f() }
  const check = () => {
    if (o.cancelled?.()) fire(o.onStop)
    else if (Date.now() >= deadline) fire(o.onStall)
  }
  const timer = setInterval(check, Math.max(10, Math.min(250, o.stallMs / 4)))
  return {
    alive: (graceMs = 0) => { if (over) return; deadline = Math.max(deadline, Date.now() + o.stallMs + graceMs); check() },
    done: () => { over = true; clearInterval(timer) },
  }
}

/**
 * A watchdog whose firing is also a promise that rejects (Stalled, or Stopped), for racing a wait that might not honour
 * an abort; `abort` is told first, so a fetch is cancelled too.
 */
export function tripwire(o: { stallMs: number; cancelled?: () => boolean; abort?: (why: Error) => void }): Watchdog & { fired: Promise<never> } {
  let reject!: (e: Error) => void
  const fired = new Promise<never>((_resolve, r) => { reject = r })
  fired.catch(() => {}) // a race that already settled leaves nobody listening
  const fire = (why: Error) => { o.abort?.(why); reject(why) }
  return { ...watchdog({ stallMs: o.stallMs, cancelled: o.cancelled, onStop: () => fire(new Stopped()), onStall: () => fire(new Stalled('stalled')) }), fired }
}

/** `p`, or Stalled when it takes the stall time, or Stopped on Stop: a wait with no bytes to count (a token refresh). */
export async function within<T>(p: Promise<T>, stallMs: number, cancelled?: () => boolean): Promise<T> {
  const t = tripwire({ stallMs, cancelled })
  try { return await Promise.race([p, t.fired]) } finally { t.done() }
}

/** The wait before try n + 1 after a stall or a dropped connection: 0.5, 1, 2, then 4 s at most. */
export const backoff = (n: number) => Math.min(2 ** (n - 1), 8) * 500

const MIB = 2 ** 20
/** Megabytes (2^20 bytes) with one decimal, for a progress line. */
export const mbWords = (n: number) => (n / MIB).toFixed(1)
/** Megabytes the Library's way: one decimal under 10 MB, none above. The phone's buttons and every line of words use this one. */
export const mb = (n: number): string => (n >= 10 * MIB ? (n / MIB).toFixed(0) : mbWords(n))
export const secsWords = (ms: number) => `${+(ms / 1000).toFixed(1)} s`
/** "at 41.2 of 88.0 MB" (or "at 41.2 MB" when the size isn't known). */
export const atWords = (got: number, size?: number) => `at ${mbWords(got)}${size ? ` of ${mbWords(size)}` : ''} MB`

/** A size for a line of words: "41 MB", "1.4 MB" (megabytes of 2^20 bytes, as the Library and the phone's buttons count). */
export const sizeWords = (bytes: number): string => `${mb(bytes)} MB`
