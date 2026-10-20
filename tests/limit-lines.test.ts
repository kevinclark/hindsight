// power/limit-not-applied with a robot-code folder: a log that ran another commit than the profile's is amber when that
// commit's CurrentLimit lines are the same (src/code/limit-lines.ts), red when they differ or can't be compared.
// The code folder is a small repo built here with git; the log is made up. The same comparisons run against GitHub,
// served from that repo by a fake (tests/helpers/fake-github.ts): one case table, two sources.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeFiles, analyzeFilesWithCode } from '../src/analyze.ts'
import { GitRepo } from '../src/code/git.ts'
import { GitHubRepo } from '../src/code/github.ts'
import type { CodeSource } from '../src/code/source.ts'
import { compareLimitLines, limitFiles, type CodeFolder, type LimitLines } from '../src/code/limit-lines.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { fakeGitHub, memoryKept } from './helpers/fake-github.ts'

const dir = mkdtempSync(join(tmpdir(), 'hindsight-limits-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

/** Commits DrumSubsystem.java with these lines and returns the commit. */
function commit(lines: string[]): string {
  writeFileSync(join(dir, 'src/main/java/frc/robot/DrumSubsystem.java'), `class Drum {\n${lines.join('\n')}\n}\n`)
  git('add', '-A')
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c')
  return git('rev-parse', 'HEAD')
}
git('init', '-q', '-b', 'main')
mkdirSync(join(dir, 'src/main/java/frc/robot'), { recursive: true })
const LIMITS = ['    cfg.CurrentLimits.SupplyCurrentLimit = 40;', '    cfg.CurrentLimits.SupplyCurrentLimitEnable = false;']
const pinned = commit(['    int speed = 1;', ...LIMITS])
const otherLinesChanged = commit(['    int speed = 2;', ...LIMITS])
const limitChanged = commit(['    int speed = 2;', LIMITS[0], '    cfg.CurrentLimits.SupplyCurrentLimitEnable = true;'])
const reordered = commit(['    int speed = 2;', LIMITS[1], LIMITS[0]])
// Two motors with the same lines (as an indexer and a kicker often are), then one of them loses its enable line.
const twice = commit([...LIMITS, ...LIMITS])
const onceLess = commit([...LIMITS, LIMITS[0]])

const profile = { ...offseason2026, code: { ...offseason2026.code, sha: pinned.slice(0, 7) } }
const flywheel = profile.motorGroups.find((g) => g.name === 'Flywheel')!
const memoryCache = (): CodeFolder['cache'] & { kept: Map<string, LimitLines> } => {
  const kept = new Map<string, LimitLines>()
  return { kept, get: (k) => kept.get(k), set: (k, v) => { kept.set(k, v) } }
}
const folder = (): CodeFolder => ({ repo: new GitRepo(nodeGitDir(dir)!), cache: memoryCache() })

/** The flywheel supply finding for a log that ran `sha`, with its supply current at 90 A against the 40 A limit. */
async function flywheelFinding(sha: string, code: CodeFolder | null) {
  const amps = (key: string, a: number): FixtureEntry => ({ name: key, type: 'double', records: [[0, 0], [10, a], [410, 0]] })
  const entries: FixtureEntry[] = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [410, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [420, 12.3]] },
    { name: '/RealMetadata/GitSHA', type: 'string', records: [[0, sha]] },
    ...flywheel.motors.flatMap((m) => [amps(m.supplyCurrent!, 90), amps(m.statorCurrent!, 10)]),
  ]
  const { analyses } = await analyzeFilesWithCode([{ name: 't.wpilog', bytes: writeWpilog(entries) }], code, profile)
  return analyses[0].report.findings.find((f) => f.rule === 'power/limit-not-applied' && f.title.startsWith('Flywheel supply'))!
}
const LINES = "current-limit lines vs the profile's commit"

const GITHUB = 'HighlanderRobotics/Rebuilt'
/** The two sources, and how each says a log's commit isn't there. */
const SOURCES: [string, () => CodeSource, RegExp][] = [
  ['a code folder', () => new GitRepo(nodeGitDir(dir)!), /commit abcdef1 isn't in this code folder/],
  ['GitHub', () => new GitHubRepo(GITHUB, memoryKept(), fakeGitHub(dir, GITHUB).fetch), /commit abcdef1 isn't on GitHub in HighlanderRobotics\/Rebuilt/],
]

describe.each(SOURCES)('comparing CurrentLimit lines between two commits, from %s', (_name, repo, logCommitMissing) => {
  it('the group\'s limit files come from its "where"', () => {
    expect(limitFiles(flywheel)).toEqual(['DrumSubsystem.java'])
  })
  it('same when only other lines changed', async () => {
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), otherLinesChanged, ['DrumSubsystem.java'])).toEqual({ verdict: 'same', files: ['DrumSubsystem.java'] })
  })
  it('different, with the lines, when a CurrentLimit line changed', async () => {
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), limitChanged, ['DrumSubsystem.java'])).toEqual({
      verdict: 'different', files: ['DrumSubsystem.java'],
      lines: ['- DrumSubsystem.java: cfg.CurrentLimits.SupplyCurrentLimitEnable = false;', '+ DrumSubsystem.java: cfg.CurrentLimits.SupplyCurrentLimitEnable = true;'],
    })
  })
  it('different when the same lines moved', async () => {
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), reordered, ['DrumSubsystem.java'])).toMatchObject({ verdict: 'different', lines: ['DrumSubsystem.java: the same lines in another order'] })
  })
  it('counts repeated lines: losing one of two identical lines is that line, not a reorder', async () => {
    expect(await compareLimitLines(repo(), twice.slice(0, 7), onceLess, ['DrumSubsystem.java'])).toMatchObject({
      verdict: 'different', lines: ['- DrumSubsystem.java: cfg.CurrentLimits.SupplyCurrentLimitEnable = false;'],
    })
  })
  it('a folder without the profile\'s commit is probably another repo, and says so', async () => {
    expect(await compareLimitLines(repo(), 'abcdef1', otherLinesChanged, ['DrumSubsystem.java'], 'HighlanderRobotics/Rebuilt')).toMatchObject({
      verdict: 'unknown', why: `the profile's commit abcdef1 isn't in ${repo().where}: is it a clone of HighlanderRobotics/Rebuilt?`,
    })
  })
  it('unknown, saying why, when the commit or the file isn\'t there', async () => {
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), 'abcdef1234567', ['DrumSubsystem.java'])).toMatchObject({ verdict: 'unknown', why: expect.stringMatching(logCommitMissing) })
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), otherLinesChanged, ['Nowhere.java'])).toMatchObject({ verdict: 'unknown', why: expect.stringMatching(/Nowhere.java isn't in commit/) })
    expect(await compareLimitLines(repo(), pinned.slice(0, 7), '', ['DrumSubsystem.java'])).toMatchObject({ verdict: 'unknown', why: 'this log has no /RealMetadata/GitSHA' })
  })
})

describe('power/limit-not-applied with a code folder', () => {
  it('another commit with the same limit lines: amber, like the pinned commit, and the evidence says so', async () => {
    const f = await flywheelFinding(otherLinesChanged, folder())
    expect(f.severity).toBe('warning')
    expect(f.title).toContain(`same current-limit lines as main ${pinned.slice(0, 7)}`)
    expect(f.evidence[LINES]).toBe(`the same as ${pinned.slice(0, 7)} in DrumSubsystem.java (read from the code folder)`)
  })
  it('another commit with different limit lines: red, with the lines that differ', async () => {
    const f = await flywheelFinding(limitChanged, folder())
    expect(f.severity).toBe('error')
    expect(f.evidence[LINES]).toMatch(/^different from [0-9a-f]{7}: - DrumSubsystem.java: .*= false;; \+ DrumSubsystem.java: .*= true;$/)
  })
  it('a commit the folder doesn\'t have: red, saying why', async () => {
    const f = await flywheelFinding('abcdef1234567890abcdef1234567890abcdef12', folder())
    expect(f.severity).toBe('error')
    expect(f.evidence[LINES]).toMatch(/^not compared: commit abcdef1 isn't in this code folder/)
  })
  it('from GitHub: the same amber answer, and every motor group shares one file list per commit', async () => {
    const github = new GitHubRepo(GITHUB, memoryKept(), fakeGitHub(dir, GITHUB).fetch)
    const f = await flywheelFinding(otherLinesChanged, { repo: github, cache: memoryCache() })
    expect(f.severity).toBe('warning')
    expect(f.evidence[LINES]).toBe(`the same as ${pinned.slice(0, 7)} in DrumSubsystem.java (read from the code folder)`)
    // The profile's short hash (1), then each commit's file list (2), for all the groups with limit files.
    expect(profile.motorGroups.filter((g) => limitFiles(g).length).length).toBeGreaterThan(5)
    expect(github.calls.api).toBe(3)
  })
  it('the pinned commit itself needs no comparison', async () => {
    const f = await flywheelFinding(pinned, folder())
    expect(f.severity).toBe('warning')
    expect(f.evidence[LINES]).toBeUndefined()
  })
  it('no code folder: exactly as analyzeFiles', async () => {
    const f = await flywheelFinding(otherLinesChanged, null)
    expect(f.severity).toBe('error')
    expect(f.evidence[LINES]).toBeUndefined()
    const sync = analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog([]) }], profile)
    expect(sync.problems).toEqual((await analyzeFilesWithCode([{ name: 't.wpilog', bytes: writeWpilog([]) }], null, profile)).problems)
  })
  it('keeps same/different answers, not "can\'t tell", and uses a kept answer without reading .git', async () => {
    const code = folder()
    await flywheelFinding(otherLinesChanged, code)
    await flywheelFinding('abcdef1234567890abcdef1234567890abcdef12', code)
    const kept = (code.cache as ReturnType<typeof memoryCache>).kept
    expect([...kept.values()].map((a) => a.verdict)).toEqual(['same'])
    const unreadable: CodeFolder = { repo: new GitRepo({ read: async () => { throw new Error('read') }, size: async () => null, list: async () => [] }), cache: code.cache }
    expect((await flywheelFinding(otherLinesChanged, unreadable)).severity).toBe('warning')
  })
})
