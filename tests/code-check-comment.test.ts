import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commentBody, hasNews, MARKER, MAX_ROWS, type CommentInput } from '../src/code/check/comment-text.ts'
import { cell, type Marked } from '../src/code/check/github-format.ts'
import { linkerFor } from '../src/code/check/head-links.ts'
import type { CodeSource } from '../src/code/source.ts'
import { parseOptions } from '../src/code/check/cli-options.ts'
import { postComment, type Fetcher } from '../src/code/check/pr-comment.ts'

const found = (over: Partial<Marked> = {}): Marked => ({
  rule: 'code/integer-division', title: 'Whole-number division', file: 'src/A.java', line: 7, message: '50 / 12 is 4 (-4.0 %)',
  evidence: {}, meaning: '', nextStep: 'Write 50.0 / 12.', isNew: true, ...over,
})
const link = { blob: 'https://github.com/o/r/blob/abc', sameText: new Set(['src/A.java']) }
const runUrl = 'https://github.com/o/r/actions/runs/42'
const body = (findings: Marked[], fixed: number | null = 0, notCompared: string | null = null, over: Partial<CommentInput> = {}) =>
  commentBody({ findings, fixed, link, notCompared, runUrl, failOn: 'none', fails: false, crashed: [], ...over })

describe('the comment text', () => {
  it('starts with the hidden marker and a header with the counts', () => {
    expect(body([found()], 0).split('\n').slice(0, 3)).toEqual([MARKER, '', '### Code check · 1 new'])
    expect(body([found()], 2)).toContain('### Code check · 1 new · 2 fixed\n')
    expect(body([found({ isNew: null })], null, 'Not compared with abc1234: no base')).toContain('### Code check · not compared\n')
  })
  it('new findings: an amber box with an icon and words, then short blocks with a linked file name', () => {
    const text = body([found(), found({ isNew: false, file: 'src/B.java', line: 3 })], 2)
    expect(text).toContain([
      '> [!WARNING]',
      '> **1 new in this change**',
      '>',
      '> **Whole-number division**',
      '> - [A.java:7](https://github.com/o/r/blob/abc/src/A.java#L7 "src/A.java") — 50 / 12 is 4 (-4.0 %).',
      '>',
      '> *Next step:* Write 50.0 / 12.',
    ].join('\n'))
    expect(text).not.toContain('Nothing new')
  })
  it('sites of one check share one block: the title with a count, a line per site, the next step once', () => {
    const text = body([found(), found({ line: 9 }), found({ rule: 'code/other', title: 'Other check', nextStep: 'Do other.' })])
    expect(text.split('Whole-number division**').length).toBe(2)               // the title once
    expect(text).toContain('> **Whole-number division** (2)\n> - [A.java:7]')
    expect(text.match(/Write 50\.0 \/ 12\./g)).toHaveLength(1)              // the next step once
    expect(text).toContain('Write 50.0 / 12.\n>\n> **Other check**\n> - [A.java:7]')
  })
  it('the same check in the folded section is grouped there too', () => {
    const text = body([found({ isNew: false }), found({ isNew: false, line: 9 })])
    expect(text).toContain('**Whole-number division** (2)\n- [A.java:7]')
  })
  it('clean: a green box with an icon and words, and fixed when more than 0', () => {
    expect(body([found({ isNew: false })], 0)).toContain('> [!TIP]\n> **Nothing new in this change.**\n')
    expect(body([found({ isNew: false })], 2)).toContain('> [!TIP]\n> **Nothing new in this change.** 2 fixed.')
  })
  it('older findings: folded, plain (no box), with the same short blocks', () => {
    const text = body([found(), found({ isNew: false, file: 'src/B.java', line: 3 })])
    expect(text).toContain('<details>\n<summary>ℹ️ 1 finding already in the code</summary>\n\n**Whole-number division**\n- [B.java:3](https://github.com/o/r/blob/abc/src/B.java "src/B.java") — ')
    expect(text.slice(text.indexOf('<details>'))).not.toContain('> ')
  })
  it('the run fails because of fail-on new: a red box that says why', () => {
    const text = body([found(), found()], 0, null, { failOn: 'new', fails: true })
    expect(text).toContain('> [!CAUTION]\n> **This run fails:** fail-on is set to new and this change adds 2 findings.')
    expect(body([found({ isNew: false })], 0, null, { failOn: 'any', fails: true })).toContain('fail-on is set to any and the code has 1 finding.')
    expect(body([found()])).not.toContain('CAUTION')
  })
  it('a check crashed: a red box that says it is not their code', () => {
    const text = body([found({ isNew: false })], 0, null, { crashed: ['code/x', 'code/y'] })
    expect(text).toContain('> [!CAUTION]\n> **A check crashed** (a bug in Hindsight, not in your code): code/x, code/y.')
  })
  it('not compared: a blue note with the reason, and every finding folded as info', () => {
    const text = body([found({ isNew: null })], null, 'Not compared with abc1234: the base is not here')
    expect(text).toContain('> [!NOTE]\n> Not compared with abc1234: the base is not here')
    expect(text).toContain('<summary>ℹ️ 1 finding</summary>')
    expect(text).not.toContain('Nothing new')
  })
  it('the footer: not a verdict, and the full report', () => {
    expect(body([found()]).trimEnd().split('\n').pop()).toBe(
      `<sub>Context for the team, not a verdict on the change or on anyone · Hindsight code check · [full report](${runUrl})</sub>`)
  })
  it('no link when the linker has none: the short name and line in code', () => {
    const text = body([found()].map((f) => f), 0, null, { link: { blob: null, sameText: new Set() } })
    expect(text).toContain('- `A.java:7` — 50 / 12 is 4')
  })
  it('keeps a message from adding HTML', () => {
    expect(body([found({ message: '<script>x</script>' })])).toContain('&lt;script&gt;x&lt;/script&gt;')
  })
  it('puts @names and #numbers in code, so nobody is mentioned and no issue is linked', () => {
    expect(cell('ask @someone, see #12')).toBe('ask `@someone`, see `#12`')
    expect(cell('a@b.com and v#1')).toBe('a@b.com and v#1')
    expect(body([found({ message: 'ask @someone, see #12' })])).toContain('ask `@someone`, see `#12`.')
  })
  it('a cut never leaves half an entity or a lone backslash', () => {
    const text = body([found({ message: `${'x'.repeat(246)}<<<` })])      // "&lt;" cut after "&l"
    expect(text).not.toMatch(/&l?t?…/)
    expect(text).toContain('x'.repeat(246) + '&lt;…')
  })
  it('hasNews: a new or a fixed finding', () => {
    expect(hasNews([found({ isNew: false })], 0)).toBe(false)
    expect(hasNews([found({ isNew: false })], 1)).toBe(true)
    expect(hasNews([found()], 0)).toBe(true)
    expect(hasNews([found({ isNew: null })], null)).toBe(false)
  })
  it('500 findings: 50 rows, the rest pointed at the run, far under the 65,536-character cap', () => {
    const long = 'x'.repeat(5000)
    const many = Array.from({ length: 500 }, (_, i) => found({ line: i + 1, message: long, nextStep: long, title: `${long}${i % 7}`, file: `${long}.java`, isNew: i < 20 }))
    const text = body(many, 3)
    expect(text.split('\n').filter((l) => /^(> )?- /.test(l)).length).toBe(MAX_ROWS)
    expect(text).toContain(`… and 450 more on [the run's summary page](${runUrl}).`)
    expect(text).toContain('<summary>ℹ️ 480 findings already in the code</summary>')
    expect(text.length).toBeLessThan(45_000)
  })
  it('odd text that would pass the cap lists fewer findings instead', () => {
    const odd = 'é'.repeat(5000)
    const many = Array.from({ length: 500 }, (_, i) => found({ line: i + 1, message: odd, nextStep: odd, title: odd, file: `${'é'.repeat(190)}.java` }))
    const text = commentBody({ findings: many, fixed: 0, link: { blob: 'https://github.com/o/r/blob/abc', sameText: new Set() }, notCompared: null, runUrl, failOn: 'none', fails: false, crashed: [] })
    expect(text.length).toBeLessThan(65_536)
  })
  it('more than 50 new: only 50 of the new are listed', () => {
    const many = Array.from({ length: 60 }, (_, i) => found({ line: i + 1 }))
    const text = body(many)
    expect(text.split('\n').filter((l) => l.startsWith('> - [A.java')).length).toBe(50)
    expect(text).toContain('**60 new in this change**')
    expect(text).toContain('… and 10 more on')
  })
})

describe('links only when they can be right', () => {
  const source = { files: async () => [{ path: 'src/A.java', sha: 'x' }], resolve: async () => 'abc' } as unknown as CodeSource
  const here = mkdtempSync(join(tmpdir(), 'code-check-ws-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'code-check-other-'))
  const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_WORKSPACE: here }
  it('the checked folder is the run\'s workspace: links', async () => {
    expect((await linkerFor(source, here, 'abc', 'abc', env)).blob).toBe('https://github.com/o/r/blob/abc')
  })
  it('another folder, a missing folder, or no workspace: plain text', async () => {
    expect((await linkerFor(source, elsewhere, 'abc', 'abc', env)).blob).toBeNull()
    expect((await linkerFor(source, join(here, 'nope'), 'abc', 'abc', env)).blob).toBeNull()
    expect((await linkerFor(source, here, 'abc', 'abc', { ...env, GITHUB_WORKSPACE: undefined })).blob).toBeNull()
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
