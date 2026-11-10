/**
 * A file read front to back in equal ranges, one range ahead: while the reader hashes and writes one range, the next is
 * already on its way, so the wait before Drive starts sending a range overlaps bytes still arriving (one range at a time,
 * the bar stopped at every piece while Drive answered the next request).
 *
 * The next range is asked for once the one before it has started arriving, not at the same moment: two ranges asked for
 * together share the link, finish together and leave their successors waiting on Drive together (a pause every two
 * pieces instead of every one). Modelled with a 300-500 ms wait per request and the link shared between bodies, a 40 MiB
 * log paused 10 times one range at a time, 5 with both asked together, and once (the first request) from first-byte at
 * 1 to 8 MiB/s; at half-received, 5 times at 8 MiB/s. At most two ranges are in flight: the one the reader asked for and
 * the next.
 *
 * `onBytes` gets the bytes received so far across both ranges, as they arrive. Stop, or `close()` (the log failed or is
 * done), tells a range still in flight to stop, and nothing it reports counts any more.
 *
 * A range read ahead is not yet the reader's: its retry words stay off the bar, and if it fails before the reader takes
 * it (a connection that sends one stream at a time can starve it while the range before it arrives), it is asked for
 * again when taken, with the bytes it had still counted. Only a failure of the range the reader is waiting on fails the
 * file.
 */
import { Stopped, type ByteSource, type TransferWatch } from './adapter.ts'

export type RangeRead = (start: number, end: number, watch: TransferWatch) => Promise<Uint8Array>
interface Range { got: number; failed: boolean; bytes: Promise<Uint8Array> }

export function readAhead(size: number, read: RangeRead, o: Omit<TransferWatch, 'onBytes'> & { onBytes?: (total: number) => void } = {}): ByteSource & { close(): void } {
  let closed = false
  let total = 0
  let piece = 0 // the range length: the reader's first ask
  let taken = -1 // the range the reader asked for last
  const ranges = new Map<number, Range>() // by index, from `taken` on
  const quiet = () => closed || !!o.cancelled?.()

  const count = (r: Range, n: number) => {
    if (quiet() || n <= r.got) return
    total += n - r.got
    r.got = n
    o.onBytes?.(total)
    next()
  }
  /** Ask for range `i`; `got` is what an earlier try of it counted already (asked again from its start, counted from there). */
  const begin = (i: number, got = 0) => {
    const start = i * piece
    const end = Math.min(size, start + piece)
    const r: Range = { got, failed: false, bytes: Promise.resolve(new Uint8Array()) }
    ranges.set(i, r)
    o.log?.(`bytes ${start}-${end - 1} of ${size}: asking${got ? ' again (the try read ahead failed)' : ''}`)
    r.bytes = read(start, end, {
      cancelled: quiet,
      onBytes: (n) => count(r, n),
      onStep: (words) => { if (!quiet() && i <= taken) o.onStep?.(words) },
      log: (line) => { if (!closed) o.log?.(line) },
    }).then((b) => { count(r, b.length); return b })
    // A range read ahead that fails is asked again when taken; one that fails once taken fails the reader's read.
    r.bytes.catch((e) => { if (!(e instanceof Stopped)) r.failed = true })
  }
  /** Ask for the range after the one the reader has, once that one has started arriving. */
  const next = () => {
    const i = taken + 1
    const prev = ranges.get(taken)
    if (quiet() || ranges.has(i) || i * piece >= size || !prev?.got) return
    begin(i)
  }

  return {
    size,
    read(start, end) {
      if (!piece) piece = end - start
      const i = start / piece
      if (!Number.isInteger(i) || i !== taken + 1 || end !== Math.min(size, start + piece)) throw new Error(`readAhead reads front to back in pieces of ${piece} bytes; asked for ${start}-${end}`)
      taken = i
      ranges.delete(i - 1)
      const had = ranges.get(i)
      if (!had || had.failed) begin(i, had?.got)
      next()
      return ranges.get(i)!.bytes
    },
    close() { closed = true; ranges.clear() },
  }
}
