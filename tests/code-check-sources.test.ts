// The code check reads the same Java from a folder's .git and from GitHub (served here from that repo by a fake,
// tests/helpers/fake-github.ts): one case, two sources, byte-identical findings, and how many GitHub API calls it took.
//   HINDSIGHT_LIVE_GITHUB=1 HINDSIGHT_LIVE_CLONE=<clone of 2026-Offseason-Robot> npx vitest run tests/code-check-sources.test.ts
// also checks the real HighlanderRobotics/2026-Offseason-Robot at cb68b20 against the clone (about 2 API calls).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeHead, headAt } from '../src/builder/code-hints.ts'
import { checkFolder } from '../src/code/check/index.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'
import { GitRepo } from '../src/code/git.ts'
import { GitHubRepo } from '../src/code/github.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { fakeGitHub, memoryKept } from './helpers/fake-github.ts'

const REPO = 'HighlanderRobotics/Made-Up-Robot'
const dir = mkdtempSync(join(tmpdir(), 'hindsight-code-check-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

function commit(files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git('add', '-A')
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c')
  return git('rev-parse', 'HEAD')
}

git('init', '-q', '-b', 'main')
const robotRuns = commit({
  'src/main/java/frc/robot/Robot.java': 'class Robot extends TimedRobot { private boolean zeroed = false; void f() { t.and(() -> !zeroed); } }',
  'src/main/java/frc/robot/IndexerIO.java': 'class IndexerIO { static final double GEAR_RATIO = 50 / 12; }',
})
const head = commit({ 'src/main/java/frc/robot/IndexerIO.java': 'class IndexerIO { static final double GEAR_RATIO = 50.0 / 12; }' })

beforeAll(loadJavaFromDisk)

describe('the code check from a folder and from GitHub', () => {
  const folder = () => new GitRepo(nodeGitDir(dir)!)
  const github = () => new GitHubRepo(REPO, memoryKept(), fakeGitHub(dir, REPO).fetch)

  it('checks the branch head when the robot is not connected, with the same findings from both', async () => {
    const fromFolder = await checkFolder(folder(), null, await codeHead(folder()))
    const hub = github()
    const fromGitHub = await checkFolder(hub, null, await headAt(hub, 'main'))
    expect(fromFolder.commit).toBe(head)
    expect(JSON.stringify(fromGitHub)).toBe(JSON.stringify(fromFolder))
    expect(fromGitHub.report.findings.map((f) => f.rule)).toEqual(['code/never-set'])
    expect(hub.calls.api).toBe(2)                        // the branch, then the tree; every file is a raw read
  })

  it('checks the commit the robot runs when the code has it, the same from both', async () => {
    const short = robotRuns.slice(0, 7)
    const fromFolder = await checkFolder(folder(), short, await codeHead(folder()))
    const hub = github()
    const fromGitHub = await checkFolder(hub, short, await headAt(hub, 'main'))
    expect(fromFolder).toMatchObject({ ranOn: 'robot', commit: robotRuns })
    expect(JSON.stringify(fromGitHub)).toBe(JSON.stringify(fromFolder))
    expect(fromGitHub.report.findings.map((f) => f.rule)).toEqual(['code/integer-division', 'code/never-set'])
  })

  it('says when the robot runs a commit GitHub doesn\'t have, and checks the branch instead', async () => {
    const hub = github()
    const checked = await checkFolder(hub, 'abcdef1', await headAt(hub, 'main'))
    expect(checked).toMatchObject({ ranOn: 'head', commit: head, branch: 'main' })
    expect(checked.why).toMatch(/^the robot runs abcdef1: .*isn't on GitHub/)
  })
})

describe.skipIf(!process.env.HINDSIGHT_LIVE_GITHUB)('live: HighlanderRobotics/2026-Offseason-Robot at cb68b20', () => {
  it('gives byte-identical findings to a local clone at the same commit', async () => {
    const live = new GitHubRepo('HighlanderRobotics/2026-Offseason-Robot', memoryKept())
    const fromGitHub = await checkFolder(live, 'cb68b20', { why: 'not used: the robot\'s commit is on GitHub' })
    console.log(`live GitHub: ${fromGitHub.files} Java files, ${fromGitHub.report.findings.length} findings, ${live.calls.api} API calls, ${live.calls.raw} raw reads`)
    expect(fromGitHub.ranOn).toBe('robot')
    const clone = process.env.HINDSIGHT_LIVE_CLONE
    if (clone) expect(JSON.stringify(fromGitHub)).toBe(JSON.stringify(await checkFolder(new GitRepo(nodeGitDir(clone)!), 'cb68b20', { why: 'not used' })))
  }, 60_000)
})
