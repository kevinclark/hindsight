/** An invented event for the board's tests: event TEST, robot "Test robot", a made-up schedule. No real match, team or verdict. */
import type { Session } from '../../src/session/session.ts'
import type { MatchSummary } from '../../src/session/summary.ts'
import type { RobotProfile } from '../../src/profiles/types.ts'
import { parseSchedule } from '../../src/tba/schedule.ts'
import { triage, type HistoryEvent } from '../../src/triage/history.ts'
import type { BoardInput } from '../../src/board/model.ts'

export const BASE = Date.UTC(2099, 2, 5, 17)
export const ROBOT = 'Test robot @ main'

export const profile = {
  name: 'Test robot', code: { repo: 'test/repo', branch: 'main', sha: 'abc1234' },
  motorGroups: [{ name: 'Flywheel', motors: [{ name: 'Flywheel left' }, { name: 'Flywheel right' }] }],
  cameras: [{ name: 'Front camera' }], otherDevices: [{ name: 'Gyro' }], zeroing: [{ mechanism: 'Arm' }],
} as unknown as RobotProfile

export interface Fire { key: string; severity?: 'error' | 'warning' | 'info'; wrongMark?: boolean }

/** A match summary. `rules`: rule id -> the keys it fired with; `checked`: rule ids that could be checked and stayed quiet. */
export function match(n: number, opts: { fires?: Fire[]; quiet?: string[]; notChecked?: string[]; onField?: boolean; robot?: string; offsetMin?: number; label?: string } = {}): MatchSummary {
  const rules: MatchSummary['rules'] = {}
  for (const f of opts.fires ?? []) {
    const rule = f.key.split(' · ')[0]
    const r = (rules[rule] ??= { status: 'fired', findings: [] })
    r.findings.push({ key: f.key, rule, severity: f.severity ?? 'error', title: `test finding ${f.key}`, time: null, matchTime: null, when: null, about: null, evidence: {}, likely: [], ruledOut: {}, ...(f.wrongMark ? { wrongMark: { reason: 'test reason', when: '2099-03-05T00:00:00Z' } } : {}) } as never)
  }
  for (const rule of opts.quiet ?? []) rules[rule] ??= { status: 'quiet', findings: [] }
  for (const rule of opts.notChecked ?? []) rules[rule] ??= { status: 'not checked', findings: [], reason: 'test reason' }
  const robot = opts.robot ?? ROBOT
  return {
    fileName: `${opts.label ?? `q${n}`}.wpilog`, fileSize: 1, playedAt: BASE + (opts.offsetMin ?? n * 20) * 60e3, playedAtSource: 'robot clock', clockNote: null,
    event: 'TEST', matchLabel: opts.onField === false ? '' : `Qualification ${n}`, onField: opts.onField ?? true, batteryId: null, rules,
    robot: { profileId: robot, name: robot.split(' @ ')[0], code: { repo: 'test/repo', branch: 'main', sha: 'abc1234' }, how: 'chosen by you', note: null, present: 10, total: 10 },
  } as unknown as MatchSummary
}

export function session(matches: MatchSummary[], pitRuns: MatchSummary[] = []): Session {
  return { id: 'event:test', label: 'Event TEST', kind: 'event', mode: 'event', matches, ...(pitRuns.length ? { pitRuns } : {}) }
}

/** The team's schedule: Q2..Q7 on Saturday (a lunch gap after Q3, 50, 130, 75, 55, 40 minutes apart), the night, Q40 and Q41 on Sunday, then a semifinal 200 minutes later. */
const row = (n: number, minutes: number | null, extra: Record<string, unknown> = {}) => ({ key: `2099test_qm${n}`, comp_level: 'qm', set_number: 1, match_number: n, time: minutes === null ? null : BASE / 1000 + minutes * 60, ...extra })
const SAT = [0, 50, 180, 255, 310, 350]
const SUN = [24 * 60 - 60 + 600, 24 * 60 - 60 + 655]
export const RAW = [
  ...SAT.map((m, i) => row(2 + i, m)), ...SUN.map((m, i) => row(40 + i, m)),
  { key: '2099test_sf1m1', comp_level: 'sf', set_number: 4, match_number: 1, time: BASE / 1000 + (SUN[1] + 200) * 60 },
]
export const SCHEDULE = parseSchedule(RAW as never)

export function input(session: Session, history: HistoryEvent[] = [], schedule: typeof SCHEDULE | null = SCHEDULE): BoardInput {
  return { session, history, marks: triage(history), schedule, profiles: [profile] }
}
