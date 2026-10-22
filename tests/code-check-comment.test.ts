import { describe, expect, it } from 'vitest'
import { commentBody, hasNews, MARKER, MAX_ROWS } from '../src/code/check/comment-text.ts'
import type { Marked } from '../src/code/check/github-format.ts'
import { parseOptions } from '../src/code/check/cli-options.ts'
import { postComment, type Fetcher } from '../src/code/check/pr-comment.ts'

const found = (over: Partial<Marked> = {}): Marked => ({
  rule: 'code/integer-division', title: 'Whole-number division', file: 'src/A.java', line: 7, message: '50 / 12 is 4 (-4.0 %)',
  evidence: {}, meaning: '', nextStep: 'Write 50.0 / 12.', isNew: true, ...over,
})
const link = { blob: 'https://github.com/o/r/blob/abc', sameText: new Set(['src/A.java']) }
const runUrl = 'https://github.com/o/r/actions/runs/42'
const body = (findings: Marked[], fixed: number | null = 0, notCompared: string | null = null) =>
  commentBody({ findings, fixed, link, notCompared, runUrl })

describe('the comment text', () => {
  it('starts with the hidden marker and a heading, and says it is not a verdict', () => {
    const text = body([found()])
    expect(text.split('\n').slice(0, 2)).toEqual([MARKER, '### Code check'])
    expect(text).toContain('context for the team, not a verdict on the change or on anyone')
  })
  it('new findings are listed, the old ones are folded, fixed is said when more than 0', () => {
    const text = body([found(), found({ isNew: false, file: 'src/B.java', line: 3 })], 2)
    expect(text).toContain('1 new in this change, 2 fixed:')
    expect(text).toContain('- **Whole-number division** at [`src/A.java:7`](https://github.com/o/r/blob/abc/src/A.java#L7)')
    expect(text).toContain('Next step: Write 50.0 / 12.')
    expect(text).toContain('50 / 12 is 4 (-4.0 %). Next step')
    expect(text).toContain('<details>\n<summary>1 finding already in the code</summary>')
    expect(text.indexOf('src/B.java')).toBeGreaterThan(text.indexOf('<details>'))
  })
  it('nothing new: says so, and does not mention fixed when there are none', () => {
    const text = body([found({ isNew: false })], 0)
    expect(text).toContain('Nothing new in this change.')
    expect(text).not.toContain('fixed')
    expect(body([found({ isNew: false })], 2)).toContain('Nothing new in this change. 2 fixed.')
  })
  it('not compared: says why in one line and folds every finding', () => {
    const text = body([found({ isNew: null })], null, 'Not compared with abc1234: the base is not here')
    expect(text).toContain('Not compared with abc1234: the base is not here')
    expect(text).toContain('<summary>1 finding</summary>')
    expect(text).not.toContain('Nothing new')
  })
  it('keeps a message from adding HTML', () => {
    expect(body([found({ message: '<script>x</script>' })])).toContain('&lt;script&gt;x&lt;/script&gt;')
  })
  it('hasNews: a new or a fixed finding', () => {
    expect(hasNews([found({ isNew: false })], 0)).toBe(false)
    expect(hasNews([found({ isNew: false })], 1)).toBe(true)
    expect(hasNews([found()], 0)).toBe(true)
    expect(hasNews([found({ isNew: null })], null)).toBe(false)
  })
  it('500 findings: 50 rows, the rest pointed at the run, far under the 65,536-character cap', () => {
    const long = 'x'.repeat(5000)
    const many = Array.from({ length: 500 }, (_, i) => found({ line: i + 1, message: long, nextStep: long, title: long, isNew: i < 20 }))
    const text = body(many, 3)
    expect(text.split('\n').filter((l) => l.startsWith('- **')).length).toBe(MAX_ROWS)
    expect(text).toContain(`… and 450 more on [the run's summary page](${runUrl}).`)
    expect(text).toContain('<summary>480 findings already in the code</summary>')
    expect(text.length).toBeLessThan(40_000)
  })
  it('more than 50 new: only 50 of the new are listed, the old folded section is empty of rows', () => {
    const many = Array.from({ length: 60 }, (_, i) => found({ line: i + 1 }))
    const text = body(many)
    expect(text.split('\n').filter((l) => l.startsWith('- **')).length).toBe(50)
    expect(text).toContain('… and 10 more on')
  })
})

// A fake GitHub: a list of the calls made, and the answers to give in order.
function fake(answers: Array<{ status: number; json?: unknown; link?: string }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | undefined }> = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ method: String(init?.method), url: String(url), headers: init?.headers as Record<string, string>, body: init?.body as string | undefined })
    const answer = answers[calls.length - 1] ?? { status: 500 }
    const headers = answer.link ? { link: answer.link } : undefined
    return new Response(answer.json === undefined ? '' : JSON.stringify(answer.json), { status: answer.status, headers })
  }
  return { calls, fetcher }
}

const pullRequestEnv = {
  GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/event.json', GITHUB_REPOSITORY: 'o/r',
  GITHUB_API_URL: 'https://api.github.test', CODE_CHECK_TOKEN: 'SECRET-TOKEN',
}
const event = (repo = 'o/r') => JSON.stringify({ pull_request: { number: 9, head: { repo: { full_name: repo } } } })
const COMMENTS = 'https://api.github.test/repos/o/r/issues/9/comments'

async function post(answers: Parameters<typeof fake>[0], over: { mayCreate?: boolean; env?: object; event?: string } = {}) {
  const github = fake(answers)
  const line = await postComment({
    body: `${MARKER}\nhello`, mayCreate: over.mayCreate ?? true, env: { ...pullRequestEnv, ...over.env },
    fetcher: github.fetcher, readEvent: () => over.event ?? event(),
  })
  return { line, calls: github.calls }
}

describe('posting the comment (fake GitHub)', () => {
  it('posts a new comment when something is new and none exists', async () => {
    const { line, calls } = await post([{ status: 200, json: [{ id: 1, body: 'someone else' }] }, { status: 201, json: {} }])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${COMMENTS}?per_page=100`, `POST ${COMMENTS}`])
    expect(JSON.parse(calls[1].body ?? '').body).toContain(MARKER)
    expect(line).toBe('PR comment: posted on #9.')
  })
  it('sends the token, the accept header and the API version, and never prints the token', async () => {
    const { line, calls } = await post([{ status: 200, json: [] }, { status: 201 }])
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer SECRET-TOKEN', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' })
    expect(line).not.toContain('SECRET-TOKEN')
  })
  it('posts nothing when nothing is new or fixed and no comment exists', async () => {
    const { line, calls } = await post([{ status: 200, json: [] }], { mayCreate: false })
    expect(calls.length).toBe(1)
    expect(line).toContain('none posted')
  })
  it('edits the existing comment (never posts a second), also when nothing is new', async () => {
    const { line, calls } = await post([{ status: 200, json: [{ id: 77, body: `${MARKER}\nold` }] }, { status: 200, json: {} }], { mayCreate: false })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${COMMENTS}?per_page=100`, 'PATCH https://api.github.test/repos/o/r/issues/comments/77'])
    expect(line).toBe('PR comment: updated comment 77 on #9.')
  })
  it('finds the marker on page 2', async () => {
    const next = `<${COMMENTS}?per_page=100&page=2>; rel="next", <${COMMENTS}?per_page=100&page=2>; rel="last"`
    const { calls } = await post([{ status: 200, json: [{ id: 1, body: 'x' }], link: next }, { status: 200, json: [{ id: 5, body: MARKER }] }, { status: 200 }])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${COMMENTS}?per_page=100`, `GET ${COMMENTS}?per_page=100&page=2`, 'PATCH https://api.github.test/repos/o/r/issues/comments/5',
    ])
  })
  it('does not follow a next page that is on another host (the token would go with it)', async () => {
    const { line, calls } = await post([{ status: 200, json: [], link: '<https://evil.test/x>; rel="next"' }])
    expect(calls.length).toBe(1)
    expect(line).toContain('unexpected next-page address')
  })
  it('skips a pull request from a fork, with one line and no call', async () => {
    const { line, calls } = await post([], { event: event('someone/fork') })
    expect(calls.length).toBe(0)
    expect(line).toContain('fork')
  })
  it('does nothing on a push, and says so', async () => {
    const { line, calls } = await post([], { env: { GITHUB_EVENT_NAME: 'push' } })
    expect(calls.length).toBe(0)
    expect(line).toBe('PR comment: not a pull request, nothing posted.')
  })
  it('a 403 prints the fix, and does not throw', async () => {
    const { line } = await post([{ status: 200, json: [] }, { status: 403, json: { message: 'Resource not accessible by integration' } }])
    expect(line).toContain('HTTP 403')
    expect(line).toContain('permissions: pull-requests: write')
  })
  it('a network failure prints one line, and does not throw', async () => {
    const line = await postComment({
      body: MARKER, mayCreate: true, env: pullRequestEnv, readEvent: () => event(),
      fetcher: async () => { throw new Error('connect ECONNREFUSED') },
    })
    expect(line).toContain('failed (connect ECONNREFUSED)')
    expect(line).not.toContain('SECRET-TOKEN')
  })
})

describe('--comment', () => {
  it('is read, and needs --github', () => {
    expect(parseOptions(['dir', '--github', '--comment'])).toMatchObject({ github: true, comment: true })
    expect(parseOptions(['dir'])).toMatchObject({ comment: false })
    expect(parseOptions(['dir', '--comment'])).toBe('--comment needs --github')
  })
})
