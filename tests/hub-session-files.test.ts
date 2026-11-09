// Library logs named for the Session view, and found again by those names (summaries restored without their file).
import { describe, expect, it } from 'vitest'
import { asFile, codeSpec, draftOffers, dsFiles, findByName, freshFiles, libraryLinks, sessionNames } from '../src/hub/session-files.ts'
import { besideOf, readBeside, type HubApi } from '../src/hub/bridge.ts'
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
  it('offers one draft per repo, at the commit most of the logs ran', () => {
    const at = (name: string, c: string, repo = 'example-org/robot-9999') => ({ name, code: { repo, linkedBy: 'sha', sha: c.repeat(40), checkedAt: 1 } as CodeLink, build: null })
    const offers = draftOffers([at('q1', 'a'), at('q2', 'b'), at('q3', 'b'), at('q4', 'c'), at('q5', 'd', 'example-org/other')])
    expect(offers.map((o) => [o.link.name, o.logs, o.total, o.refs])).toEqual([['q2', 2, 4, 3], ['q5', 1, 1, 1]])
    expect(draftOffers([at('q1', 'a'), at('q2', 'b')])[0].link.name).toBe('q1')
    expect(draftOffers([])).toEqual([])
  })
})

describe('a library log opens with its Driver Station files', () => {
  const gone = 'logs/2025-2026/2026-02-19/gone.dslog'
  const api = { readLog: async (path: string) => { if (path === gone) throw new Error(`${path} is not on this computer`); return new TextEncoder().encode(path) } } as unknown as HubApi
  const att = (kind: LogRecord['kind'], path: string) => ({ type: 'log', kind, sha256: path, path, size: 2, modifiedTime: 7, recordedAt: 1 }) as LogRecord
  const robot = entry('ffffffff66', 'logs/2025-2026/2026-02-19/akit_26-02-19_q4.wpilog')
  const dslog = att('dslog', 'logs/2025-2026/2026-02-19/2026_02_19 12_00_00 Thu.dslog')
  const dsevents = att('dsevents', 'logs/2025-2026/2026-02-19/2026_02_19 12_00_00 Thu.dsevents')
  const elsewhere = att('dslog', 'logs/2025-2026/2026-02-19/2026_02_19 12_05_00 Thu.dslog')
  const hoot = att('hoot', 'logs/2025-2026/2026-02-19/ABC_2026-02-19_12-00-00.hoot')
  const withDs: Entry = { ...robot, attached: { dslog: [dslog, elsewhere], dsevents: [dsevents], hoot: [hoot] }, held: [robot.record.path, dslog.path, dsevents.path, hoot.path] }
  const libraryOf = (entries: Entry[]) => ({ ...api, library: async () => ({ entries, skipped: 0, libraryDir: '', machineId: '' }) }) as unknown as HubApi

  it('brings the attached .dslog and .dsevents this computer holds, named by their file name; not one held only on Drive, nor hoot files', () => {
    expect(dsFiles(withDs, api).map((f) => f.name)).toEqual(['2026_02_19 12_00_00 Thu.dslog', '2026_02_19 12_00_00 Thu.dsevents'])
    expect(dsFiles({ ...withDs, held: undefined }, api)).toEqual([])
  })
  it('puts them beside the robot log, which keeps the name the session knows it by, and reads each one\'s own bytes', async () => {
    const file = asFile({ entry: withDs, name: 'akit_26-02-19_q4.wpilog' }, api)
    expect(file.name).toBe('akit_26-02-19_q4.wpilog')
    const unread: string[] = []
    const read = await readBeside(file, unread)
    expect(read.map((r) => [r.name, new TextDecoder().decode(r.bytes)])).toEqual([['2026_02_19 12_00_00 Thu.dslog', dslog.path], ['2026_02_19 12_00_00 Thu.dsevents', dsevents.path]])
    expect(unread).toEqual([])
    expect(besideOf(besideOf(file)[0])).toEqual([]) // a DS file brings nothing more
  })
  it('a DS file that can no longer be read is left out and named, and never stops the log', async () => {
    const lost = att('dslog', gone)
    const file = asFile({ entry: { ...withDs, attached: { ...withDs.attached, dslog: [lost] }, held: [...withDs.held!, gone] }, name: 'q4.wpilog' }, api)
    const unread: string[] = []
    expect((await readBeside(file, unread)).map((r) => r.name)).toEqual(['2026_02_19 12_00_00 Thu.dsevents'])
    expect(unread).toEqual(['gone.dslog: not read (logs/2025-2026/2026-02-19/gone.dslog is not on this computer), so q4.wpilog was read without it'])
  })
  it('a file chosen from disk, or a log with nothing attached, comes alone', async () => {
    expect(besideOf(new File([new Uint8Array(1)], 'q5.wpilog'))).toEqual([])
    expect(await readBeside(asFile({ entry: a, name: 'akit_26-02-19_q1.wpilog' }, api), [])).toEqual([])
  })
  it('a log kept since an earlier read picks up DS files attached since, under the name it was given; other files stay as they were', async () => {
    const before = asFile({ entry: robot, name: 'Log_1-ffffffff.wpilog' }, api)
    const chosen = new File([new Uint8Array(1)], 'q5.wpilog')
    const gonePath = asFile({ entry: b1, name: 'Log_1.wpilog' }, api)
    const now = await freshFiles(libraryOf([withDs]), [before, chosen, gonePath])
    expect(now.map((f) => f.name)).toEqual(['Log_1-ffffffff.wpilog', 'q5.wpilog', 'Log_1.wpilog'])
    expect(besideOf(now[0]).map((f) => f.name)).toEqual(['2026_02_19 12_00_00 Thu.dslog', '2026_02_19 12_00_00 Thu.dsevents'])
    expect(now[1]).toBe(chosen)
    expect(now[2]).toBe(gonePath)
  })
})
