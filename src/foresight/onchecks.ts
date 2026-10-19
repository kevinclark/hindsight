/**
 * The team's own pit checklist (2026 Pit Checklist, sections 6, 9 and 10), in its order and words, with each line
 * marked from Foresight's checks: OK, a problem (red or amber), not checked, "check by eye" (nothing on the robot can
 * tell), or not yet (a check Foresight doesn't have yet).
 *
 * It is a view of the verdict, never an input to it: a line is marked only from the current check's results, a
 * "by eye" line never counts toward GO, and a proven check that could not run still makes the verdict NOT CHECKED
 * whatever the lines show (verdict.ts).
 */
import type { Report } from '../rules/index.ts'
import type { Verdict } from './verdict.ts'

export interface OncheckLine {
  section: string
  line: string
  /** Foresight checks that cover the line. */
  rules?: string[]
  /** Nothing on the robot can tell: a person checks it. */
  byEye?: boolean
  /** Not covered yet, and why. */
  notYet?: string
  /** What the checks cover of the line, when it is only part of it. */
  note?: string
}

export const ONCHECKS: OncheckLine[] = [
  { section: 'Battery', line: 'Fresh battery installed', rules: ['power/rest-voltage', 'battery/identity', 'battery/gauge-capacity'], note: 'the team installs at 13.0 V on the PDH (13.3 V on the gauge); Foresight flags under 12.5 V at rest, measured at another moment' },
  { section: 'Controllers', line: 'Controllers plugged into the DS and working', rules: ['foresight/controllers'], note: 'plugged in on the right ports; whether they work is by eye' },
  { section: 'Controllers', line: 'Backup controller', byEye: true },
  { section: 'Software', line: 'All cameras on and detecting AprilTags', rules: ['vision/stale', 'vision/time-sync'], note: 'connected and time-synced; detecting tags is not checked yet' },
  { section: 'Software', line: 'Elastic open with the correct layout', byEye: true },
  { section: 'Software', line: 'Correct auto selected in Elastic', byEye: true },
  { section: 'Software', line: 'Other windows closed on the DS laptop', byEye: true },
  { section: 'Software', line: 'No alerts on Elastic', rules: ['alerts/passthrough'] },
  { section: 'Software', line: 'Mechanisms zeroed', rules: ['foresight/zero-sanity'], note: 'the intake pivot against its CANcoder; the hood has no absolute encoder' },
  { section: 'Software', line: 'CANcoder offsets correct and unchanged', notYet: 'needs the offsets in the robot profile, or the diagnostic server (phase 2)' },
  { section: 'Software', line: 'Swerve ratio unchanged', notYet: 'needs the motors\' configuration read back (phase 2)' },
  { section: 'Software', line: 'All CAN devices licensed and ID\'d', notYet: 'needs the diagnostic server (phase 2)' },
  { section: 'Software', line: 'All device values updating', rules: ['can/device-dropout'], note: 'devices connected; values that stop changing are not checked yet' },
  { section: 'Software', line: 'Log stick in', notYet: 'the robot code does not publish it yet' },
  { section: 'Software', line: 'Gyro seems normal', rules: ['foresight/gyro-still-drift'], note: 'heading drift while still, as context: no line yet' },
  { section: 'Software', line: 'No undeployed changes', rules: ['build/dirty', 'foresight/commit-matches'] },
  { section: 'Software', line: 'No motors overheating', notYet: 'motor temperatures are not in the robot profile yet' },
]

export type LineState = 'ok' | 'red' | 'amber' | 'context' | 'not checked' | 'by eye' | 'not yet'

export interface MarkedLine extends OncheckLine { state: LineState; detail: string }

/** Mark each line from the current check (null: nothing current, e.g. settling, closed or stale). */
export function markOnchecks(current: { verdict: Verdict; report: Report } | null): MarkedLine[] {
  return ONCHECKS.map((l) => {
    if (l.byEye) return { ...l, state: 'by eye', detail: 'check by eye' }
    if (l.notYet) return { ...l, state: 'not yet', detail: `not checked yet: ${l.notYet}` }
    if (!current) return { ...l, state: 'not checked', detail: 'no current check' }
    const rules = l.rules ?? []
    const items = current.verdict.items.filter((i) => rules.includes(i.finding.rule))
    const worst = items.find((i) => i.level === 'red') ?? items.find((i) => i.level === 'amber')
    if (worst) return { ...l, state: worst.level as 'red' | 'amber', detail: worst.finding.title }
    const blind = new Set([...current.report.skipped.filter((s) => !s.reason.startsWith('partly')), ...current.report.crashed].map((s) => s.rule))
    const ran = rules.filter((r) => !blind.has(r))
    if (ran.length === 0) return { ...l, state: 'not checked', detail: 'its checks could not read their signals' }
    const context = items.find((i) => i.level === 'grey')
    if (context && items.every((i) => i.level === 'grey') && rules.every((r) => r === context.finding.rule)) return { ...l, state: 'context', detail: context.finding.title }
    return { ...l, state: 'ok', detail: l.note ?? 'OK' }
  })
}
