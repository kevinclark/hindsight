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
  /**
   * Checks that need a person's help (e.g. holding a tag up to a camera): their context (grey) findings are the step to
   * do, so the line shows "Do" with the step until they clear. Never a fault, never counted toward GO.
   */
  assisted?: string[]
}

export const ONCHECKS: OncheckLine[] = [
  { section: 'Battery', line: 'Fresh battery installed', rules: ['power/rest-voltage', 'battery/identity', 'battery/gauge-capacity'], note: 'the team installs at 13.0 V on the PDH (13.3 V on the gauge); Foresight flags under 12.5 V at rest, measured at another moment' },
  { section: 'Controllers', line: 'Controllers plugged into the DS and working', rules: ['foresight/controllers'], note: 'plugged in on the right ports; whether they work is by eye' },
  { section: 'Controllers', line: 'Backup controller', byEye: true },
  { section: 'Software', line: 'All cameras on and detecting AprilTags', rules: ['vision/stale', 'vision/time-sync', 'foresight/camera-sees-tag'], assisted: ['foresight/camera-sees-tag'], note: 'connected, time-synced and each saw a tag' },
  { section: 'Software', line: 'Elastic open with the correct layout', byEye: true },
  { section: 'Software', line: 'Correct auto selected in Elastic', byEye: true },
  { section: 'Software', line: 'Other windows closed on the DS laptop', byEye: true },
  { section: 'Software', line: 'No alerts on Elastic', rules: ['alerts/passthrough'] },
  { section: 'Software', line: 'Mechanisms zeroed', rules: ['foresight/zero-sanity'], note: 'the intake pivot against its CANcoder; the hood has no absolute encoder' },
  { section: 'Software', line: 'CANcoder offsets correct and unchanged', notYet: 'needs the diagnostic server (phase 2): the offset (MagnetOffset) is in the CANcoder\'s config, not in the log' },
  { section: 'Software', line: 'Swerve ratio unchanged', notYet: 'needs the motors\' configuration read back (phase 2)' },
  { section: 'Software', line: 'All CAN devices licensed and ID\'d', notYet: 'needs the diagnostic server (phase 2)' },
  { section: 'Software', line: 'All device values updating', rules: ['can/device-dropout', 'foresight/values-updating'], note: 'devices connected and their readings changing; not the CANcoders or flywheel motors (nothing of theirs changes at rest)' },
  { section: 'Software', line: 'Log stick in', notYet: 'needs the robot code to publish it (students, phase 1b)' },
  { section: 'Software', line: 'Gyro seems normal', rules: ['foresight/gyro-still-drift'], note: 'heading drift while still, as context: no line yet' },
  { section: 'Software', line: 'No undeployed changes', rules: ['build/dirty', 'foresight/commit-matches'] },
  { section: 'Software', line: 'No motors overheating', rules: ['foresight/motor-temperature'], note: 'every motor at or under 60 °C (hotter than any ended a CalGames match)' },
]

/** Every check that asks a person to do something (its grey findings are a step, not context). */
export const ASSISTED_RULES = new Set(ONCHECKS.flatMap((l) => l.assisted ?? []))

export type LineState = 'ok' | 'red' | 'amber' | 'to do' | 'context' | 'not checked' | 'by eye' | 'not yet'

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
    const steps = items.filter((i) => i.level === 'grey' && l.assisted?.includes(i.finding.rule))
    if (steps.length) return { ...l, state: 'to do', detail: steps.map((i) => i.finding.title).join('; ') }
    const blind = new Set([...current.report.skipped.filter((s) => !s.reason.startsWith('partly')), ...current.report.crashed].map((s) => s.rule))
    const ran = rules.filter((r) => !blind.has(r))
    if (ran.length === 0) return { ...l, state: 'not checked', detail: 'its checks could not read their signals' }
    // An assisted check that skipped any part (one camera unread) can't vouch for the line.
    const skippedStep = current.report.skipped.find((s) => l.assisted?.includes(s.rule)) ?? current.report.crashed.find((s) => l.assisted?.includes(s.rule))
    if (skippedStep) return { ...l, state: 'not checked', detail: `${skippedStep.rule}: ${skippedStep.reason}` }
    const context = items.find((i) => i.level === 'grey')
    if (context && items.every((i) => i.level === 'grey') && rules.every((r) => r === context.finding.rule)) return { ...l, state: 'context', detail: context.finding.title }
    return { ...l, state: 'ok', detail: l.note ?? 'OK' }
  })
}
