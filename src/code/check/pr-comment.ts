/**
 * Puts the code check's comment on a pull request, or edits the one already there. The HTTP call is passed in (`fetcher`,
 * Node's fetch in the real run), so tests use a fake. Nothing here throws and nothing changes the exit code: a comment
 * that can't be posted is one printed line saying why and what to change.
 */
import { MARKER } from './comment-text.ts'

/** Same shape as Node's fetch. */
export type Fetcher = typeof fetch

/** Everything the posting needs. */
export interface PostInput {
  /** The comment's Markdown (starts with MARKER). */
  body: string
  /** True when a new comment may be created (something is new or fixed). An existing comment is always edited. */
  mayCreate: boolean
  /** The step's environment: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL, CODE_CHECK_TOKEN. */
  env: NodeJS.ProcessEnv
  fetcher: Fetcher
  /** Reads the event file's text (fs.readFileSync in the real run). */
  readEvent: (path: string) => string
}

/** What this run is about: a pull request (from this repository) and its number, or why there is none. */
type PullRequest = { number: number } | { skip: string }

const FIX = "give this job `permissions: pull-requests: write`"

/** Posts or edits the comment. Returns the one line to print. */
export async function postComment(input: PostInput): Promise<string> {
  try {
    return await postOrEdit(input)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return `PR comment: failed (${why}); ${FIX} if it is a permission problem. The check itself is unaffected.`
  }
}

async function postOrEdit({ body, mayCreate, env, fetcher, readEvent }: PostInput): Promise<string> {
  const pull = pullRequestOf(env, readEvent)
  if ('skip' in pull) return `PR comment: ${pull.skip}`
  const token = env.CODE_CHECK_TOKEN
  const repository = env.GITHUB_REPOSITORY
  if (!token || !repository) return 'PR comment: skipped, no token or no repository in the environment.'
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '')
  const call = (method: string, url: string, json?: object) => request(fetcher, token, method, url, json)

  const existing = await findComment(call, api, `${api}/repos/${repository}/issues/${pull.number}/comments?per_page=100`)
  if (typeof existing === 'string') return existing
  if (existing) {
    const done = await call('PATCH', `${api}/repos/${repository}/issues/comments/${existing.id}`, { body })
    return done.ok ? `PR comment: updated comment ${existing.id} on #${pull.number}.` : failure('update', done.status)
  }
  if (!mayCreate) return `PR comment: nothing new or fixed and no comment yet, none posted on #${pull.number}.`
  const done = await call('POST', `${api}/repos/${repository}/issues/${pull.number}/comments`, { body })
  return done.ok ? `PR comment: posted on #${pull.number}.` : failure('post', done.status)
}

/** The pull request this run is for, read from the event file; or the reason there is no comment. */
function pullRequestOf(env: NodeJS.ProcessEnv, readEvent: (path: string) => string): PullRequest {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return { skip: 'not a pull request, nothing posted.' }
  if (!env.GITHUB_EVENT_PATH) return { skip: 'skipped, GITHUB_EVENT_PATH is not set.' }
  const event = JSON.parse(readEvent(env.GITHUB_EVENT_PATH))
  const number = event?.pull_request?.number
  if (!Number.isInteger(number)) return { skip: 'skipped, the event has no pull request number.' }
  if (event.pull_request.head?.repo?.full_name !== env.GITHUB_REPOSITORY) {
    return { skip: 'pull request from a fork: its token is read-only, so no comment was posted. The run summary has the report.' }
  }
  return { number }
}

type Call = (method: string, url: string, json?: object) => Promise<Reply>

/** What the API said: the status, the JSON (if any) and the next page's address (if any). */
interface Reply {
  ok: boolean
  status: number
  json: unknown
  next: string | null
}

/** One HTTP call. The token goes in a header and is never printed. */
async function request(fetcher: Fetcher, token: string, method: string, url: string, json?: object): Promise<Reply> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (json) headers['Content-Type'] = 'application/json'
  const response = await fetcher(url, { method, headers, body: json ? JSON.stringify(json) : undefined })
  const text = await response.text()
  return { ok: response.ok, status: response.status, json: text ? safeJson(text) : null, next: nextPage(response.headers.get('link')) }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The address after `rel="next"` in a Link header, or null on the last page. */
function nextPage(link: string | null): string | null {
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link ?? '')
  return match ? match[1] : null
}

/** The pull request's comment that starts with the marker (looking through the pages), null if none, or a line to print. */
async function findComment(call: Call, api: string, firstPage: string): Promise<{ id: number } | null | string> {
  let url: string | null = firstPage
  while (url) {
    if (!url.startsWith(`${api}/`)) return 'PR comment: failed (an unexpected next-page address); nothing posted.'
    const page: Reply = await call('GET', url)
    if (!page.ok) return failure('read the comments', page.status)
    const comments = Array.isArray(page.json) ? page.json : []
    const found = comments.find((c) => typeof c?.body === 'string' && c.body.startsWith(MARKER))
    if (found) return { id: found.id }
    url = page.next
  }
  return null
}

/** The one line for a failed call: what failed, and the usual fix. */
function failure(what: string, status: number): string {
  return `PR comment: could not ${what} (HTTP ${status}); ${FIX} (a pull request from a fork never gets one). The check itself is unaffected.`
}
