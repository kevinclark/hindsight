/**
 * "Hindsight x.y is out: download". The Mac build is unsigned, so it cannot update itself silently; on start the app asks
 * the public repo's releases once and, when a newer app release exists, the page shows a banner with its link. The repo
 * also publishes robot-snapshot releases, so only tags that are plain app versions (v1.2.3) count.
 */
export const RELEASES_URL = 'https://api.github.com/repos/kevinclark/hindsight/releases?per_page=30'

const APP_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

export interface Update { version: string; url: string }

const parts = (v: string): number[] => v.split('.').map(Number)

/** True when `latest` (x.y.z) is a higher version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const [a, b] = [parts(latest), parts(current)]
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/** The newest published app release that is newer than `current`, or null (also when GitHub can't be reached: no banner is no news). */
export async function checkForUpdate(current: string, doFetch: typeof fetch = fetch): Promise<Update | null> {
  try {
    const res = await doFetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const releases = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }[]
    const apps = releases
      .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === 'string' && APP_TAG.test(r.tag_name) && typeof r.html_url === 'string')
      .map((r) => ({ version: r.tag_name!.slice(1), url: r.html_url! }))
      .sort((x, y) => (isNewer(x.version, y.version) ? -1 : isNewer(y.version, x.version) ? 1 : 0))
    const newest = apps[0]
    return newest && isNewer(newest.version, current) ? newest : null
  } catch { return null }
}
