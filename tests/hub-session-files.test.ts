// Library logs named for the Session view, and found again by those names (summaries restored without their file).
import { describe, expect, it } from 'vitest'
import { codeSpec, findByName, libraryLinks, sessionNames } from '../src/hub/session-files.ts'
import type { HubApi } from '../src/hub/bridge.ts'
import type { Entry } from '../src/hub/catalog.ts'
import type { CodeLink, LogRecord } from '../src/hub/types.ts'

function entry(sha256: string, path: string, over: { names?: string[]; local?: boolean } = {}): Entry {
  const record = { type: 'log', kind: 'wpilog', sha256, path, size: 1, modifiedTime: 5, recordedAt: 1 } as LogRecord
  return { record, names: over.names ?? [path.slice(path.lastIndexOf('/') + 1)], tags: {}, attached: { dslog: [], dsevents: [], hoot: [] }, local: over.local ?? true, shared: false, toFetch: [] }
}

const a = entry('aaaaaaaa11', 'logs/2025-2026/2026-02-19/akit_26-02-19_q1.wpilog')
const b1 = entry('bbbbbbbb22', 'logs/2025-2026/2026-02-19/Log_1.wpilog')
const b2 = entry('cccccccc33', 'logs/2025-2026/2026-02-20/Log_1.wpilog')
const renamed = entry('dddddddd44', 'logs/2025-2026/2026-02-21/akit_26-02-21_q2.wpilog', { names: ['akit_26-02-21_q2.wpilog', 'copy of q2.wpilog'] })
const remote = entry('eeeeeeee55', 'logs/2025-2026/2026-02-22/akit_26-02-22_q3.wpilog', { local: false })

describe('session names', () => {
  it('is the file name, with the sha-256 start where two logs share one', () => {
    expect(sessionNames([a, b1, b2]).map((n) => n.name)).toEqual(['akit_26-02-19_q1.wpilog', 'Log_1-bbbbbbbb.wpilog', 'Log_1-cccccccc.wpilog'])
  })
})

describe('finding logs by a session name', () => {
  const all = [a, b1, b2, renamed, remote]
  const found = (names: string[]) => findByName(all, names).map((n) => [n.name, n.entry.record.sha256])
  it('finds the log filed under the name, keeping the name the session knows it by', () => {
    expect(found(['akit_26-02-19_q1.wpilog'])).toEqual([['akit_26-02-19_q1.wpilog', 'aaaaaaaa11']])
  })
  it('finds a log by its name with the sha-256 start, or a name it was brought in under', () => {
    expect(found(['Log_1-cccccccc.wpilog', 'copy of q2.wpilog'])).toEqual([['Log_1-cccccccc.wpilog', 'cccccccc33'], ['copy of q2.wpilog', 'dddddddd44']])
  })
  it('finds nothing for a name two logs share, a log not on this computer, or an unknown name', () => {
    expect(found(['Log_1.wpilog', 'akit_26-02-22_q3.wpilog', 'nope.wpilog'])).toEqual([])
  })
})

describe('code links of library logs', () => {
  const sha = 'a'.repeat(40)
  const linked: CodeLink = { repo: 'example-org/robot-9999', linkedBy: 'sha', sha, checkedAt: 1 }
  const withLink = (e: Entry, code: unknown, build: LogRecord['build'] = { sha: 'abc1234', branch: 'main' }): Entry => ({ ...e, record: { ...e.record, code, build } as LogRecord })
  const api = (entries: Entry[]) => ({ library: async () => ({ entries, skipped: 0, libraryDir: '', machineId: '' }) }) as unknown as HubApi

  it('returns the link and build of each named log that has a well-formed link, keeping the session name', async () => {
    const entries = [withLink(a, linked), b1, withLink(renamed, { repo: 'not a repo' }), withLink(remote, linked)]
    expect(await libraryLinks(api(entries), ['akit_26-02-19_q1.wpilog', 'Log_1.wpilog', 'akit_26-02-21_q2.wpilog', 'akit_26-02-22_q3.wpilog'])).toEqual([
      { name: 'akit_26-02-19_q1.wpilog', code: linked, build: { sha: 'abc1234', branch: 'main' } },
    ])
  })
  it('names the GitHub ref the builder reads: the commit when GitHub has it, else the branch the log ran, else main', () => {
    expect(codeSpec({ code: linked, build: null })).toBe(`example-org/robot-9999@${sha}`)
    const byName: CodeLink = { repo: 'example-org/robot-9999', linkedBy: 'codebase', checkedAt: 1 }
    expect(codeSpec({ code: byName, build: { sha: 'abc1234', branch: 'event-test' } })).toBe('example-org/robot-9999@event-test')
    expect(codeSpec({ code: byName, build: null })).toBe('example-org/robot-9999@main')
  })
})
