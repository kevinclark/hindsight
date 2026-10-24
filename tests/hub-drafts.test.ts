// Which robots the Library offers a profile draft for, and from which log, on invented data.
import { describe, expect, it } from 'vitest'
import type { Entry } from '../src/hub/catalog.ts'
import { robotsToProfile } from '../src/hub/drafts.ts'
import type { CodeLink, LogRecord } from '../src/hub/types.ts'

const SHA = (c: string) => c.repeat(40)
const bySha = (repo: string, sha: string): CodeLink => ({ repo, linkedBy: 'sha', sha, checkedAt: 1 })
const byName = (repo: string): CodeLink => ({ repo, linkedBy: 'codebase', checkedAt: 1 })

function entry(sha256: string, over: Partial<LogRecord> = {}, local = true): Entry {
  const record: LogRecord = {
    type: 'log', sha256, kind: 'wpilog', playedAt: 1000, dateSource: 'robot clock', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
    onField: false, batteryId: null, roboRio: null, edition: null, robot: { profileId: null, name: 'TestBot', how: 'codebase', fit: 0.2 }, build: null, stub: false,
    hardwareId: null, size: 1, path: `logs/x/${sha256}.wpilog`, names: [`${sha256}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm1', ...over,
  }
  return { record, names: record.names, tags: {}, attached: { dslog: [], dsevents: [], hoot: [] }, local, shared: false, toFetch: [] }
}
const sourceLog = (entries: Entry[]) => {
  const s = robotsToProfile(entries, new Set())[0].source
  return s.kind === 'draft' ? s.entry.record.sha256 : s.kind
}

describe('robotsToProfile', () => {
  it('lists each robot that only a Codebase text names, once, counting its logs but not its stubs', () => {
    const robots = robotsToProfile([
      entry('a'), entry('b'), entry('c', { stub: true }),
      entry('d', { robot: { profileId: 'p', name: 'Profiled', how: 'codebase', fit: 1 } }),
      entry('e', { robot: null }),
      entry('f', { robot: { profileId: null, name: 'OtherBot', how: 'codebase', fit: null } }),
    ], new Set())
    expect(robots.map((r) => [r.name, r.logs])).toEqual([['OtherBot', 1], ['TestBot', 2]])
  })

  it('leaves out a robot whose Codebase a profile kept in this browser names: the review already uses that profile', () => {
    expect(robotsToProfile([entry('a')], new Set(['TestBot']))).toEqual([])
  })

  it('drafts from the newest log on this computer linked by its commit, a match on the field first', () => {
    expect(sourceLog([
      entry('old-field', { playedAt: 1000, onField: true, code: bySha('team/bot', SHA('1')) }),
      entry('new-pit', { playedAt: 3000, code: bySha('team/bot', SHA('2')) }),
      entry('new-field', { playedAt: 2000, onField: true, code: bySha('team/bot', SHA('3')) }),
      entry('newest-remote', { playedAt: 4000, onField: true, code: bySha('team/bot', SHA('4')) }, false),
      entry('newest-stub', { playedAt: 5000, onField: true, stub: true, code: bySha('team/bot', SHA('5')) }),
      entry('by-name', { playedAt: 6000, onField: true, code: byName('team/bot') }),
    ])).toBe('new-field')
  })

  it('drafts from a log linked by name only when none of the robot\'s logs here is linked by commit', () => {
    expect(sourceLog([
      entry('by-name-old', { playedAt: 1, code: byName('team/bot') }),
      entry('by-name-new', { playedAt: 2, code: byName('team/bot') }),
      entry('by-commit-remote', { playedAt: 3, code: bySha('team/bot', SHA('1')) }, false),
    ])).toBe('by-name-new')
  })

  it('counts a log with no date as the oldest', () => {
    expect(sourceLog([entry('undated', { playedAt: null, code: bySha('team/bot', SHA('1')) }), entry('dated', { playedAt: 1, code: bySha('team/bot', SHA('2')) })])).toBe('dated')
  })

  it('says when the only logs linked to code are not on this computer', () => {
    const [robot] = robotsToProfile([entry('a', { code: bySha('team/bot', SHA('1')) }, false), entry('b')], new Set())
    expect(robot.source).toEqual({ kind: 'not here', code: bySha('team/bot', SHA('1')) })
  })

  it('says when no code is linked', () => {
    expect(sourceLog([entry('a')])).toBe('no code')
  })
})
