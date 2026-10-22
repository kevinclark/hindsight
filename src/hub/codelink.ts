/**
 * Link a robot log to the repository whose code it ran, for logs whose robot no profile names (only a Codebase text).
 * Public GitHub, no token, read only. Run only when the user presses "Link code", never while describing a log.
 *
 * Requests (the unauthenticated API allows 60 an hour per network):
 *   - API: one `GET /orgs/{org}/repos?per_page=100` per 100 repos of an org (or `GET /repos/{owner}/{repo}` for a named
 *     repo), and one `GET /repos/{owner}/{repo}/commits/{sha}` per (candidate repo, build commit), read only for `.sha`;
 *   - raw.githubusercontent.com (not counted by GitHub): each repo's `src/main/java/frc/robot/Robot.java` at its default
 *     branch, searched for `recordMetadata("Codebase", "<text>")`. No other branch or tag is tried.
 * Stops at the first answer saying no requests remain; what was linked before is kept. No node: imports (the page uses
 * `describeCodeLink`).
 */
import type { CodeLink, LogRecord } from './types.ts'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const ROBOT_JAVA = 'src/main/java/frc/robot/Robot.java'
const CODEBASE = /recordMetadata\(\s*"Codebase"\s*,\s*"([^"]+)"/
const SOURCE = /^[\w.-]+(\/[\w.-]+)?$/

export interface RepoInfo { full: string; defaultBranch: string; pushedAt: string }

export const validSource = (text: string): boolean => SOURCE.test(text) && !text.includes('..')

/** A log that could be linked: its robot is only a code name, and the link isn't already by commit. */
export function linkable(r: LogRecord): boolean {
  return r.kind === 'wpilog' && !!r.robot && r.robot.profileId === null && r.robot.name !== '' && r.code?.linkedBy !== 'sha'
}

/** The most requests pressing the button will make against GitHub's API: listing each source, plus one commit check per distinct (Codebase, build) among linkable logs. */
export function estimateRequests(sources: string[], records: LogRecord[]): number {
  if (sources.length === 0) return 0
  const builds = new Set(records.filter(linkable).filter((r) => r.build).map((r) => `${r.robot!.name}\u0000${r.build!.sha}`))
  return sources.length + builds.size
}

export interface LinkResult {
  links: Map<string, CodeLink>
  /** Logs with a Codebase text that no listed repo records. */
  unmatched: number
  repos: number
  requests: { api: number; raw: number }
  /** Set when GitHub said no requests remain; ms since 1970 when they come back. */
  rateLimitedUntil: number | null
  /** Problems worth showing (a source that could not be listed). */
  problems: string[]
}

class RateLimited extends Error {
  resetAt: number
  constructor(resetAt: number) { super('GitHub rate limit reached'); this.resetAt = resetAt }
}

export async function linkCode(sources: string[], records: LogRecord[], options: { get?: typeof fetch; now?: () => number; cancelled?: () => boolean; onProgress?: (done: number, total: number, current: string) => void } = {}): Promise<LinkResult> {
  const get = options.get ?? fetch
  const now = options.now ?? Date.now
  const result: LinkResult = { links: new Map(), unmatched: 0, repos: 0, requests: { api: 0, raw: 0 }, rateLimitedUntil: null, problems: [] }
  let remaining = Infinity
  const api = async (path: string): Promise<Response> => {
    if (remaining <= 0) throw new RateLimited(result.rateLimitedUntil ?? now())
    result.requests.api++
    const res = await get(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json' } })
    const left = res.headers.get('x-ratelimit-remaining')
    if (left !== null) remaining = Number(left)
    if (left === '0' || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      result.rateLimitedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now()
      remaining = 0
      // A 200 with the last request spent is still an answer; a refusal is not.
      if (res.status === 403 || res.status === 429) throw new RateLimited(result.rateLimitedUntil)
    }
    return res
  }

  const todo = records.filter(linkable)
  try {
    // 1. The repos, and the Codebase text each records.
    const repos: RepoInfo[] = []
    for (const source of sources) {
      try { repos.push(...(await list(source, api))) } catch (e) { if (e instanceof RateLimited) throw e; result.problems.push(`${source}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    result.repos = repos.length
    const wanted = new Set(todo.map((r) => r.robot!.name))
    const byCodebase = new Map<string, RepoInfo[]>()
    let n = 0
    if (wanted.size > 0) for (const repo of repos) {
      if (options.cancelled?.()) break
      options.onProgress?.(n++, repos.length, repo.full)
      const text = await readRaw(get, repo, result)
      const name = text ? CODEBASE.exec(text)?.[1] : undefined
      if (name && wanted.has(name)) byCodebase.set(name, [...(byCodebase.get(name) ?? []), repo])
    }

    // 2. Each log: candidates by Codebase text, the commit if it has one.
    const held = new Map<string, Promise<string | null>>()
    const holds = (repo: RepoInfo, sha: string) => {
      const key = `${repo.full}@${sha}`
      if (!held.has(key)) held.set(key, commitSha(api, repo.full, sha))
      return held.get(key)!
    }
    let done = 0
    for (const r of todo) {
      if (options.cancelled?.()) break
      options.onProgress?.(done++, todo.length, r.names[0] ?? r.path)
      const candidates = byCodebase.get(r.robot!.name) ?? []
      if (candidates.length === 0) { result.unmatched++; continue }
      let holders: { repo: RepoInfo; sha: string }[] = []
      if (r.build) {
        for (const c of candidates) { const full = await holds(c, r.build.sha); if (full) holders.push({ repo: c, sha: full }) }
      }
      const pool = holders.length ? holders.map((h) => h.repo) : candidates
      const chosen = preferred(pool)
      const others = candidates.filter((c) => c !== chosen).map((c) => c.full)
      const sha = holders.find((h) => h.repo === chosen)?.sha
      const link: CodeLink = { repo: chosen.full, linkedBy: sha ? 'sha' : 'codebase', ...(sha ? { sha } : {}), ...(others.length ? { candidates: others } : {}), checkedAt: now() }
      result.links.set(r.sha256, link)
    }
  } catch (e) {
    if (e instanceof RateLimited) result.rateLimitedUntil = e.resetAt
    else result.problems.push(e instanceof Error ? e.message : String(e)) // what was linked before is kept
  }
  return result
}

/** The tie-break between repos that record one Codebase text: a name that is not a template or training repo, then the latest push. */
export function preferred(repos: RepoInfo[]): RepoInfo {
  const plain = (r: RepoInfo) => !/template|training/i.test(r.full.split('/')[1] ?? '')
  return [...repos].sort((a, b) => Number(plain(b)) - Number(plain(a)) || b.pushedAt.localeCompare(a.pushedAt) || a.full.localeCompare(b.full))[0]
}

async function list(source: string, api: (path: string) => Promise<Response>): Promise<RepoInfo[]> {
  const one = (r: { full_name: string; default_branch: string; pushed_at: string | null }): RepoInfo => ({ full: r.full_name, defaultBranch: r.default_branch, pushedAt: r.pushed_at ?? '' })
  if (source.includes('/')) {
    const res = await api(`/repos/${source}`)
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    return [one((await res.json()) as never)]
  }
  const out: RepoInfo[] = []
  for (let page = 1; ; page++) {
    const res = await api(`/orgs/${source}/repos?per_page=100&page=${page}`)
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const rows = (await res.json()) as never[]
    out.push(...rows.map(one))
    if (rows.length < 100) return out
  }
}

async function readRaw(get: typeof fetch, repo: RepoInfo, result: LinkResult): Promise<string | null> {
  result.requests.raw++
  try {
    const res = await get(`${RAW}/${repo.full}/${encodeURIComponent(repo.defaultBranch)}/${ROBOT_JAVA}`)
    return res.ok ? await res.text() : null
  } catch { return null }
}

/** The full commit hash if the repo has the commit, null on a 404 or 422 (not there). Only `.sha` is read from the answer. */
async function commitSha(api: (path: string) => Promise<Response>, repo: string, sha: string): Promise<string | null> {
  const res = await api(`/repos/${repo}/commits/${encodeURIComponent(sha)}`)
  if (res.status === 404 || res.status === 422) return null
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for a commit`)
  const full = ((await res.json()) as { sha?: unknown }).sha
  return typeof full === 'string' && /^[0-9a-f]{40}$/.test(full) ? full : null
}

/** How the Library view words a link, and where it points. */
export function describeCodeLink(r: Pick<LogRecord, 'code' | 'build'>): { text: string; url: string } | null {
  const c = r.code
  if (!c) return null
  const repoUrl = `https://github.com/${c.repo}`
  if (c.linkedBy === 'sha' && c.sha) return { text: `${c.repo} @ ${c.sha.slice(0, 7)}`, url: `${repoUrl}/commit/${c.sha}` }
  const sha = r.build?.sha.slice(0, 7)
  return { text: `${c.repo} (named by the log${sha ? `; commit ${sha} not on GitHub` : ''})`, url: repoUrl }
}
