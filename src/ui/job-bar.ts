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

/** The speed is the rate over the last RATE_WINDOW_MS; "no data" shows once nothing has moved for QUIET_MS. */
export const RATE_WINDOW_MS = 5_000
export const QUIET_MS = 3_000

/** Bytes per second over the last RATE_WINDOW_MS of samples, or null with under half a second of them. */
export function rateOver(samples: Sample[]): number | null {
  if (samples.length < 2) return null
  const last = samples[samples.length - 1]
  const first = samples.find((s) => last.at - s.at <= RATE_WINDOW_MS) ?? last
  const span = last.at - first.at
  if (span < 500) return null
  return Math.max(0, (last.bytes - first.bytes) / (span / 1000))
}

/** "1.4 MB/s", "320 kB/s". */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 2 ** 20) return `${(bytesPerSecond / 2 ** 20).toFixed(1)} MB/s`
  const k = Math.round(bytesPerSecond / 1024)
  return k < 1 ? '<1 kB/s' : `${k} kB/s`
}

/** Milliseconds since the bytes last grew, as of `now` (since the first sample if they never have). 0 with no samples. */
export function quietFor(samples: Sample[], now: number): number {
  if (samples.length === 0) return 0
  for (let i = samples.length - 1; i > 0; i--) if (samples[i].bytes > samples[i - 1].bytes) return Math.max(0, now - samples[i].at)
  return Math.max(0, now - samples[0].at)
}

/** "no data for 7 s" once nothing has moved for QUIET_MS, else ''. */
export function noDataText(quietMs: number): string {
  return quietMs >= QUIET_MS ? `no data for ${Math.floor(quietMs / 1000)} s` : ''
}
