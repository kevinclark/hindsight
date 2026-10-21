import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// scripts/code-check.ts run as a person (or the GitHub Action) runs it, on the sample repo of invented code that
// scripts/make-code-check-sample.sh builds: at the head 13 findings, 12 new, 1 fixed.
let sample = ''
let base = ''

beforeAll(() => {
  sample = join(mkdtempSync(join(tmpdir(), 'code-check-sample-')), 'repo')
  base = spawnSync('sh', ['scripts/make-code-check-sample.sh', sample], { encoding: 'utf8' }).stdout.trim()
})

function run(...args: string[]) {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' }
  const done = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/code-check.ts', sample, ...args], { encoding: 'utf8', env })
  return { code: done.status, out: done.stdout, err: done.stderr }
}

describe('code-check.ts on the sample repo', () => {
  it('without new flags: the plain list, exit 1 on findings, no comparison', () => {
    const { code, out } = run()
    expect(code).toBe(1)
    expect(out).toContain('13 findings; 0 places it couldn\'t judge')
    expect(out).not.toContain('[new]')
    expect(out).not.toContain('Compared')
  })

  it('--base counts what is new and fixed, and marks the new ones', () => {
    const { out } = run('--base', base, '--fail-on', 'none')
    expect(out).toContain('13 findings, 12 new in this change, 1 fixed')
    expect(out.match(/\[new\]/g)).toHaveLength(12)
    expect(out).not.toMatch(/Gears\.java:6 .*\[new\]/)       // the finding that only moved down a line
  })

  it('--fail-on: none never fails, new fails on a new finding, any fails on any', () => {
    expect(run('--base', base, '--fail-on', 'none').code).toBe(0)
    expect(run('--base', base, '--fail-on', 'new').code).toBe(1)
    expect(run('--base', base, '--fail-on', 'any').code).toBe(1)
  })

  it('--fail-on new passes when the change adds nothing: compared with itself', () => {
    const head = spawnSync('git', ['-C', sample, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const { code, out } = run('--base', head, '--fail-on', 'new')
    expect(out).toContain('13 findings, 0 new in this change, 0 fixed')
    expect(code).toBe(0)
  })

  it('an unreadable base is said in one line, nothing is compared, and --fail-on new does not fail', () => {
    const { code, out } = run('--base', 'deadbeefdeadbeef', '--fail-on', 'new')
    expect(out.match(/Not compared with deadbee/g)).toHaveLength(1)
    expect(out).not.toContain('[new]')
    expect(code).toBe(0)
  })

  it('--exclude-rules leaves a rule out of both sides', () => {
    const { code, out } = run('--base', base, '--exclude-rules', 'code/integer-division', '--fail-on', 'new')
    expect(out).toContain('0 findings; ')
    expect(out).toContain('0 findings, 0 new in this change, 0 fixed')
    expect(code).toBe(0)
  })

  it('--github prints 10+ warnings as annotations, writes the summary and the outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-check-out-'))
    const summaryFile = join(dir, 'summary.md')
    const outputFile = join(dir, 'output.txt')
    writeFileSync(summaryFile, 'earlier step\n')
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/sample' }
    const done = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/code-check.ts', sample, '--base', base, '--github', '--fail-on', 'none'], { encoding: 'utf8', env })
    expect(done.stdout.match(/^::warning /gm)).toHaveLength(12)
    expect(done.stdout.match(/^::notice /gm)).toHaveLength(1)
    expect(done.stdout).toContain('%25)')
    const summary = readFileSync(summaryFile, 'utf8')
    expect(summary).toMatch(/^earlier step\n### Code check/)          // appended, not overwritten
    expect(summary).toContain('13 findings, 12 new in this change, 1 fixed.')
    expect(readFileSync(outputFile, 'utf8')).toBe('findings=13\nnew=12\nfixed=1\ncompared=true\n')
  })

  it('a bad option exits 2 with the usage', () => {
    const { code, err } = run('--fail-on', 'sometimes')
    expect(code).toBe(2)
    expect(err).toContain('usage:')
  })
})
