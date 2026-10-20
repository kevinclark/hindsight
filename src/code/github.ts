/**
 * Robot code from a public GitHub repo, with no token: the same questions as a code folder's .git (src/code/git.ts),
 * answered over the network. Read only: GET requests, no credentials, nothing sent but the repo and commit asked for.
 *
 * Without signing in, GitHub's API allows 60 calls an hour per network (a whole venue's Wi-Fi may share them), so:
 *   - a branch or short hash costs 1 call (`commits/{ref}`); a full 40-character hash costs none;
 *   - a commit's list of files costs 1 call (`git/trees/{sha}?recursive=1`), kept by commit in `kept`, which never
 *     goes stale (a commit's files never change), so a second visit costs nothing;
 *   - every file's text comes from raw.githubusercontent.com at the full commit hash, never a branch name (a branch can
 *     move between two reads), and doesn't count against the 60.
 * Answers are also shared in memory while they are on the way, so 13 motor groups asking for one commit cost 1 call.
 *
 * Commit answers carry people's names and emails: only `.sha` is ever read from them, and the body is never kept.
 */
import { CommitMissing, GitUnreadable } from './git.ts'
import type { CodeFileEntry, CodeSource, Kept } from './source.ts'

const API = 'https://api.github.com/repos'
const RAW = 'https://raw.githubusercontent.com'
const FULL_SHA = /^[0-9a-f]{40}$/
const OR_FOLDER = 'choose the code folder instead'

/** GitHub couldn't answer now (offline, the hourly limit, a server error): worth asking again later, unlike a 404. */
class NotNow extends GitUnreadable {}

export class GitHubRepo implements CodeSource {
  readonly repo: string
  readonly where: string
  /** Calls made, for the scripts' reports: `api` counts against GitHub's 60 an hour, `raw` doesn't. */
  readonly calls = { api: 0, raw: 0 }
  private resolving = new Map<string, Promise<string>>()
  private listing = new Map<string, Promise<CodeFileEntry[]>>()
  private reading = new Map<string, Promise<string>>()
  private kept: Kept<CodeFileEntry[] | string>
  private get: typeof fetch

  /** `repo` is "owner/name"; `kept` remembers commits' files and short hashes; `get` is fetch (a fake in tests). */
  constructor(repo: string, kept: Kept<CodeFileEntry[] | string>, get: typeof fetch = fetch) {
    this.repo = repo
    this.where = `${repo} on GitHub`
    this.kept = kept
    this.get = get
  }

  /** The full commit hash a branch, hash or short hash names. */
  resolve(ref: string): Promise<string> {
    const wanted = ref.trim()
    if (FULL_SHA.test(wanted.toLowerCase())) return Promise.resolve(wanted.toLowerCase())
    return this.once(this.resolving, wanted, async () => {
      const key = `sha:${this.repo}@${wanted}`
      // Only a short hash is kept: it always names the same commit. A branch moves, so it's asked again each visit.
      const kept = this.kept.get(key)
      if (typeof kept === 'string') return kept
      const { sha } = (await this.api(`commits/${pathOf(wanted)}`, wanted)) as { sha: string }
      if (/^[0-9a-f]{7,39}$/i.test(wanted)) this.kept.set(key, sha)
      return sha
    })
  }

  /** Every file in a commit (a full hash), with its blob hash. Submodules are left out, as in a code folder. */
  files(commit: string): Promise<CodeFileEntry[]> {
    return this.once(this.listing, commit, async () => {
      const key = `tree:${this.repo}@${commit}`
      const kept = this.kept.get(key)
      if (Array.isArray(kept)) return kept
      const tree = (await this.api(`git/trees/${commit}?recursive=1`, commit)) as { truncated: boolean; tree: { path: string; type: string; sha: string }[] }
      if (tree.truncated) throw new GitUnreadable(`GitHub sent only part of ${this.repo}'s file list at ${commit.slice(0, 7)} (too many files): ${OR_FOLDER}`)
      const files = tree.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }))
      this.kept.set(key, files)
      return files
    })
  }

  /** A file's text at a commit (a full hash), from raw.githubusercontent.com. */
  textAt(commit: string, path: string): Promise<string> {
    return this.once(this.reading, `${commit}:${path}`, async () => {
      this.calls.raw++
      const answer = await this.fetch(`${RAW}/${this.repo}/${commit}/${pathOf(path)}`)
      if (answer.status === 404) throw new GitUnreadable(`${path} isn't in commit ${commit.slice(0, 7)}`)
      if (!answer.ok) throw new NotNow(`GitHub answered ${answer.status} for ${path}: ${OR_FOLDER}`)
      return answer.text()
    })
  }

  /** One API call, its answer as JSON. Every way it can fail becomes a reason a person can act on. */
  private async api(path: string, ref: string): Promise<unknown> {
    this.calls.api++
    const answer = await this.fetch(`${API}/${this.repo}/${path}`)
    if (answer.ok) return answer.json()
    if (answer.headers.get('x-ratelimit-remaining') === '0') throw new NotNow(limitUsedUp(answer.headers.get('x-ratelimit-reset')))
    // Measured 2026-10-20: a repo that is private or doesn't exist answers 404; a commit or branch it lacks, 422.
    if (answer.status === 404) throw new GitUnreadable(`GitHub has no public repo ${this.repo} (private, misspelled or gone): ${OR_FOLDER}`)
    if (answer.status === 422) throw new CommitMissing(`commit ${ref.slice(0, 7)} isn't on GitHub in ${this.repo} (not pushed, rebased away or misspelled): ${OR_FOLDER}`)
    throw new NotNow(`GitHub answered ${answer.status} for ${this.repo}: ${OR_FOLDER}`)
  }

  /** A GET with no credentials; offline or blocked becomes a reason, never a thrown network error. */
  private async fetch(url: string): Promise<Response> {
    try {
      return await this.get(url, { credentials: 'omit' })
    } catch {
      throw new NotNow(`couldn't reach GitHub (offline?): ${OR_FOLDER}`)
    }
  }

  /** Shares an answer, or a lasting no (a 404 or 422), with everyone who asks; forgets a "not now", to ask again. */
  private once<T>(pending: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
    let answer = pending.get(key)
    if (!answer) {
      answer = work()
      pending.set(key, answer)
      answer.catch((error) => { if (error instanceof NotNow) pending.delete(key) })
    }
    return answer
  }
}

/** "owner/name@branch" (or a pasted github.com link) → its parts. Null when it isn't one. */
export function parseGitHub(text: string): { repo: string; ref: string } | null {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/tree\/|@)(\S+)$/.exec(text.trim())
  return m ? { repo: m[1], ref: m[2] } : null
}

/** "Your limit is used up; it resets at 15:07", in this computer's time. */
function limitUsedUp(reset: string | null): string {
  const at = reset ? new Date(Number(reset) * 1000) : null
  const when = at && !Number.isNaN(at.getTime()) ? `; it resets at ${at.toTimeString().slice(0, 5)}` : ''
  return `GitHub's limit for this network (60 an hour without signing in) is used up${when}. Choose the code folder instead.`
}

/** A path or branch name for a URL: each part encoded, the slashes kept. */
const pathOf = (path: string) => path.split('/').map(encodeURIComponent).join('/')
