// Foresight's queue checklist on two of the team's real 2026 logs (tests/helpers/team-logs.ts: A, C), the live check taken
// just before the first enable after the field attached, as scripts/foresight-backtest.ts takes it. Skipped when the list
// is absent. Prints nothing: it asserts verdict words and counts only. The deferrals are invented (event TEST wording:
// "test workaround") on two issue keys the board finds in the log's match.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TEAM } from './helpers/team-logs.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num } from '../src/match/match.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES, profileId } from '../src/profiles/index.ts'
import { RecordStore } from '../src/foresight/records.ts'
import { evaluateForesight, SETTLE_SECONDS } from '../src/foresight/engine.ts'
import { foresightKeysIn } from '../src/foresight/keys.ts'
import { DATALOGMANAGER_SIGNALS } from '../src/profiles/datalogmanager.ts'
import { boardFor, openDeferrals, queueChecklist, tickAt } from '../src/foresight/checklists.ts'
import { summarizeLog } from '../src/session/summary.ts'
import type { Session } from '../src/session/session.ts'
import type { BoardEvent } from '../src/triage/history.ts'

// The drivetrain's on-blocks tick, fresh (Kevin, 2026-10-24: every match).
const BLOCKS = new Map([['Drivetrain' as const, tickAt('pit', new Date().toISOString(), Date.now())]])
const have = !!TEAM.logA && !!TEAM.logC && existsSync(TEAM.logA) && existsSync(TEAM.logC)

/** The engine's check on the field-attached, disabled robot just before its first enable. */
function liveCheck(path: string) {
  const log = openWpilog(new Uint8Array(readFileSync(path)))
  const { profile, choice } = chooseProfile(log, PROFILES)
  const match = buildMatch('replay', log, profile, choice)
  const fms = num(match, match.profile.signals.fmsAttached)
  const attach = fms ? Array.from(fms.t).find((_, i) => fms.v[i] > 0.5) : undefined
  const enable = attach === undefined ? undefined : match.enabled.find((iv) => iv.start > attach)?.start
  if (attach === undefined || enable === undefined) throw new Error('the log has no field-attached disabled stretch')
  const keys = [...foresightKeysIn(log, profile), ...Object.values(DATALOGMANAGER_SIGNALS).flat()]
  const store = RecordStore.fromWpilog(log, keys)
  const now = enable - 0.1
  if (now <= Math.max(match.logStart + SETTLE_SECONDS, attach)) throw new Error('enabled before the check could settle')
  const result = evaluateForesight({ store, codeStart: match.logStart, now, lastPassingSha: null, profile })
  if (result.state !== 'checked') throw new Error(`not checked: ${result.state}`)
  return { profile, result }
}

describe.skipIf(!have)('the queue checklist on the team\'s logs', () => {
  it('log C: NO-GO, with no deferral open', () => {
    const { profile, result } = liveCheck(TEAM.logC!)
    const q = queueChecklist({ verdict: result.verdict, why: '', profile, deferrals: [], deferralNote: null })
    expect(q.word).toBe('NO-GO')
    expect(q.rows.filter((r) => r.word === 'No-go').length).toBeGreaterThan(0)
  })

  it('log A with two invented open deferrals on two keys the board finds in its match: GO WITH 2 DEFERRALS, both named', () => {
    const { profile, result } = liveCheck(TEAM.logA!)
    const summary = summarizeLog({ name: 'replay.wpilog', bytes: new Uint8Array(readFileSync(TEAM.logA!)) })!
    const session = { id: 'event:replay', label: 'Event TEST', kind: 'event', mode: 'event', matches: [summary] } as Session
    // The live check and the summary name the same robot, or the deferrals would be filed under another.
    expect(summary.robot.profileId).toBe(profileId(profile))
    const keys = boardFor(session, [], profile, new Date()).issues.map((i) => i.key)
    expect(keys.length).toBeGreaterThanOrEqual(2)
    const history: BoardEvent[] = keys.slice(0, 2).flatMap((key, n): BoardEvent[] => [
      { type: 'board', v: 1, key, robot: profileId(profile), op: 'workaround', value: `test workaround ${n + 1}`, event: summary.event, by: { device: 'd', role: 'pit' }, seq: 2 * n + 1, when: '2099-03-05T20:00:00Z' },
      { type: 'board', v: 1, key, robot: profileId(profile), op: 'defer', value: 'end-of-event', until: { kind: 'end-of-event' }, event: summary.event, by: { device: 'd', role: 'pit' }, seq: 2 * n + 2, when: '2099-03-05T20:00:00Z' },
    ])
    const open = openDeferrals(boardFor(session, history, profile, new Date()), profile)
    expect(open).toHaveLength(2)
    const q = queueChecklist({ verdict: result.verdict, why: '', profile, deferrals: open, deferralNote: null, ticks: BLOCKS })
    expect(q.word).toBe('GO WITH 2 DEFERRALS')
    expect(q.kind).toBe('GO WITH DEFERRALS')
    expect(q.rows.flatMap((r) => r.deferrals).map((d) => d.workaround).sort()).toEqual(['test workaround 1', 'test workaround 2'])
    // The two read as workarounds on their own rows, each system either Go with deferral or (never green, never plain Go) nothing less.
    expect(q.rows.filter((r) => r.deferrals.length).every((r) => r.word === 'Go with deferral')).toBe(true)
    expect(q.rows.some((r) => r.word === 'No-go')).toBe(false)
  })

  it('log C with every live red deferred (invented) is a go with those deferrals, none hidden', () => {
    const { profile, result } = liveCheck(TEAM.logC!)
    const reds = result.verdict.items.filter((i) => i.level === 'red')
    expect(reds.length).toBeGreaterThan(0)
    const deferrals = reds.map((i) => ({ key: i.finding.key, system: 'Code' as const, title: 'test issue', workaround: 'test workaround', until: 'the end of the event' }))
    const q = queueChecklist({ verdict: result.verdict, why: '', profile, deferrals, deferralNote: null, ticks: BLOCKS })
    expect(q.rows.some((r) => r.word === 'No-go')).toBe(false)
    expect(q.word).toBe(`GO WITH ${deferrals.length} ${deferrals.length === 1 ? 'DEFERRAL' : 'DEFERRALS'}`)
  })
})
