/**
 * The one rule every transfer follows (the robot over SFTP, Google Drive over HTTP): a link that goes quiet never errors by
 * itself, so a transfer that sees nothing move for STALL_MS fails with words, and Stop is looked for a few times a second
 * even while nothing arrives. No `node:` import here, so the phone build can bundle it with the Drive reader.
 */

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

export const mbWords = (n: number) => (n / 2 ** 20).toFixed(1)
export const secsWords = (ms: number) => `${+(ms / 1000).toFixed(1)} s`
/** "at 41.2 of 88.0 MB" (or "at 41.2 MB" when the size isn't known). */
export const atWords = (got: number, size?: number) => `at ${mbWords(got)}${size ? ` of ${mbWords(size)}` : ''} MB`
