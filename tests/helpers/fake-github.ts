// A stand-in for GitHub, for tests with no network: it answers the three requests src/code/github.ts makes, in the
// shapes GitHub's answers have (measured 2026-10-20), from a small repo built in the test with git. Commit answers
// carry only `sha` and the tree's sha: never an author.
import { execFileSync } from 'node:child_process'
import type { CodeFileEntry, Kept } from '../../src/code/source.ts'

export interface FakeGitHub {
  fetch: typeof fetch
  /** Every URL asked for, in order. */
  asked: string[]
  /** How each request was made (credentials, headers), to check nothing credential-shaped is sent. */
  inits: (RequestInit | undefined)[]
}

/** GitHub serving `dir` as `repo` ("owner/name"); any other repo is a 404, as a private or missing one is. */
export function fakeGitHub(dir: string, repo: string): FakeGitHub {
  const asked: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const commit = (ref: string) => { try { return git('rev-parse', '--verify', '-q', `${ref}^{commit}`).trim() } catch { return null } }
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    inits.push(init)
    const api = new RegExp(`^https://api\\.github\\.com/repos/${repo}/(commits/(.+)|git/trees/([0-9a-f]+)\\?recursive=1)$`).exec(url)
    const raw = new RegExp(`^https://raw\\.githubusercontent\\.com/${repo}/([0-9a-f]{40})/(.+)$`).exec(url)
    if (api?.[2]) {
      const sha = commit(decodeURIComponent(api[2]))
      if (!sha) return json(422, { message: `No commit found for SHA: ${api[2]}` })
      return json(200, { sha, commit: { tree: { sha: git('rev-parse', `${sha}^{tree}`).trim() } } })
    }
    if (api?.[3]) {
      const sha = commit(api[3])
      if (!sha) return json(422, { message: 'Invalid object requested. SHA must identify a commit or a tree.' })
      const tree = git('ls-tree', '-r', '-t', sha).trim().split('\n').map((line) => {
        const [meta, path] = line.split('\t')
        const [mode, type, blob] = meta.split(' ')
        return { path, mode, type, sha: blob }
      })
      return json(200, { sha, truncated: false, tree })
    }
    if (raw) {
      try {
        return new Response(git('show', `${raw[1]}:${raw[2].split('/').map(decodeURIComponent).join('/')}`), { status: 200 })
      } catch {
        return new Response('404: Not Found', { status: 404 })
      }
    }
    return json(404, { message: 'Not Found' })
  }
  return { fetch: fake as typeof fetch, asked, inits }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** Kept answers in memory, like localStorage for one page. */
export function memoryKept<T = CodeFileEntry[] | string>(): Kept<T> & { kept: Map<string, T> } {
  const kept = new Map<string, T>()
  return { kept, get: (k) => kept.get(k), set: (k, v) => { kept.set(k, v) } }
}
