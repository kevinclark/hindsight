/**
 * "Hindsight x.y is out: download". The Mac build is unsigned, so it cannot update itself silently; the app asks the public
 * repo's releases (on start and every few hours, electron/updater.ts) and, when a newer app release exists, the update chip offers its link. The repo
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

/**
 * The newest published app release that is newer than `current`, or null when there is none. A request that fails (GitHub
 * refused, or couldn't be reached) throws an Error saying so: "no newer release" and "couldn't ask" are different answers.
 */
export async function checkForUpdate(current: string, doFetch: typeof fetch = fetch): Promise<Update | null> {
  let res: Response
  try { res = await doFetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } }) } catch (e) {
    throw new Error(`GitHub could not be reached (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  try {
    const releases = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }[]
    const apps = releases
      .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === 'string' && APP_TAG.test(r.tag_name) && typeof r.html_url === 'string')
      .map((r) => ({ version: r.tag_name!.slice(1), url: r.html_url! }))
      .sort((x, y) => (isNewer(x.version, y.version) ? -1 : isNewer(y.version, x.version) ? 1 : 0))
    const newest = apps[0]
    return newest && isNewer(newest.version, current) ? newest : null
  } catch { throw new Error('GitHub sent an answer Hindsight could not read') }
}

/**
 * Whether the app updates itself (electron-updater) rather than only showing the banner. Only an installed build: a dev run
 * has nothing to replace. Windows and Linux update unsigned; Squirrel.Mac needs a signed build, which the release workflow
 * marks with __MAC_SIGNED__. Where this is false the banner stays the way to learn of a release.
 */
export function selfUpdates(o: { isPackaged: boolean; platform: string; macSigned: boolean }): boolean {
  if (!o.isPackaged) return false
  if (o.platform === 'win32' || o.platform === 'linux') return true
  return o.platform === 'darwin' && o.macSigned
}
