/**
 * A file read in ranges front to back, one range ahead: while the reader hashes and writes one range, the next is already
 * on its way, so the wait before Drive starts sending a range overlaps bytes still arriving (one range at a time, the bar
 * stopped at every piece while Drive answered the next request). At most two ranges are in flight.
 *
 * `onBytes` gets the bytes received so far across both ranges, as they arrive. `close()` abandons a range read ahead that
 * nothing took (the log failed or was stopped): its read is told to stop, and nothing it reports counts any more.
 */
import type { ByteSource, TransferWatch } from './adapter.ts'

export type RangeRead = (start: number, end: number, watch: TransferWatch) => Promise<Uint8Array>

export function readAhead(size: number, read: RangeRead, o: Omit<TransferWatch, 'onBytes'> & { onBytes?: (total: number) => void } = {}): ByteSource & { close(): void } {
  let closed = false
  let total = 0
  const got = new Map<number, number>() // range start → bytes received
  const count = (start: number, n: number) => {
    const had = got.get(start) ?? 0
    if (closed || n <= had) return
    got.set(start, n)
    total += n - had
    o.onBytes?.(total)
  }
  const watch = (start: number): TransferWatch => ({
    cancelled: () => closed || !!o.cancelled?.(),
    onBytes: (n) => count(start, n),
    onStep: (words) => { if (!closed) o.onStep?.(words) },
    log: o.log,
  })
  const fetch = (start: number, end: number) => {
    const bytes = read(start, end, watch(start)).then((b) => { count(start, b.length); return b })
    bytes.catch(() => {}) // a range read ahead fails when it is taken, or never if it is abandoned
    return { start, end, bytes }
  }
  let ahead: ReturnType<typeof fetch> | null = null
  return {
    size,
    read(start, end) {
      const now = ahead?.start === start && ahead.end === end ? ahead : fetch(start, end)
      ahead = end < size ? fetch(end, Math.min(size, end + (end - start))) : null
      return now.bytes
    },
    close() { closed = true },
  }
}
