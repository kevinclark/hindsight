/** Sizes and time left for the job bar. */

/** 812 kB → "0.8 MB", 41 MB, 1.2 GB. */
export const size = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${(n / 2 ** 20).toFixed(n < 10 * 2 ** 20 ? 1 : 0)} MB`)

/** Time left for a job counted in bytes, from the bytes done over time. */
export interface Sample { at: number; bytes: number }

/** The rate is taken over the last WINDOW_MS (a link speeds up and slows down); nothing is shown before SETTLE_MS of samples. */
export const WINDOW_MS = 30_000
export const SETTLE_MS = 5_000

/** "about 4 min left", "under a minute left", or '' while the rate has not settled (or nothing is moving). */
export function estimateLeft(samples: Sample[], total: number): string {
  if (samples.length < 2) return ''
  const last = samples[samples.length - 1]
  if (last.at - samples[0].at < SETTLE_MS) return ''
  const first = samples.find((s) => last.at - s.at <= WINDOW_MS) ?? samples[0]
  const rate = (last.bytes - first.bytes) / Math.max(1, last.at - first.at) // bytes per ms
  if (rate <= 0) return ''
  const ms = (total - last.bytes) / rate
  if (ms < 60_000) return 'under a minute left'
  const min = Math.round(ms / 60_000)
  return min < 90 ? `about ${min} min left` : `about ${Math.round(min / 6) / 10} h left`
}
