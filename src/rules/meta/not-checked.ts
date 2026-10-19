/**
 * meta/not-checked — list every rule that couldn't run on this log.
 *
 * Checks: nothing in the log. The runner collects each rule whose signals were missing (or that said it couldn't
 * run), and this turns the list into one grey finding.
 * Why: an empty report has to mean "looked and found nothing", never "couldn't look". CalGames Q13 has no
 * accelerometer, so collision/impact can't run on it.
 * When it fires: if a rule you care about is listed, add the missing signal to the robot's logging.
 */
import type { Finding } from '../types.ts'

export interface SkippedRule { rule: string; reason: string }

export function notCheckedFinding(skipped: SkippedRule[]): Finding | null {
  if (skipped.length === 0) return null
  return {
    rule: 'meta/not-checked',
    severity: 'info',
    title: `${skipped.length} rule${skipped.length === 1 ? '' : 's'} not checked: signals missing`,
    time: null,
    evidence: Object.fromEntries(skipped.map((s) => [s.rule, s.reason])),
  }
}
