import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve('scripts/release-changes.sh')
let dir: string
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' })
const commit = (message: string) => git('commit', '--allow-empty', '-q', '-m', message)
const changes = () => execFileSync('sh', [script], { cwd: dir, encoding: 'utf8' }).trim().split('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-changes-'))
  git('init', '-q')
  commit('first')
  commit('old\n\nChangelog: Already released.')
  git('tag', 'v0.1.2')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('release-changes', () => {
  it('lists the trailers since the last release, oldest first, beside other trailers', () => {
    commit('a\n\nChangelog: Pulls try Ethernet first.\nCo-Authored-By: T <t@example.com>')
    commit('no line for this one')
    commit('b\n\nChangelog: CAN IDs can come from your notes.')
    expect(changes()).toEqual(['- Pulls try Ethernet first.', '- CAN IDs can come from your notes.'])
  })
  it('lists a line once, including from a merged branch', () => {
    git('checkout', '-q', '-b', 'side')
    commit('c\n\nChangelog: One change.')
    git('checkout', '-q', '-')
    commit('d\n\nChangelog: One change.')
    git('merge', '-q', '--no-ff', '--no-edit', 'side')
    expect(changes()).toEqual(['- One change.'])
  })
  it('says so plainly when no commit has a line', () => {
    commit('tests only')
    expect(changes()).toEqual(['- Small fixes and behind-the-scenes work.'])
  })
})
