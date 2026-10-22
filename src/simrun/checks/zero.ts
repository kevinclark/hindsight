/**
 * A zero (a mechanism driven into its hard stop to find its position) was cut off, or never finished, or runs on
 * every enable when the team says it runs once.
 *
 * The zeroes and their done messages come from the team's scenario file and the Hindsight robot profile. Commands
 * have no names a tool can rely on, so the zero's command is found from the runs themselves: the command that
 * finishes soonest after the done message prints (CalGames Q13's hood zero is a SequentialCommandGroup needing
 * DrumSubsystem, which finishes a loop or two after "Rezeroed hood"), preferring one that needs a subsystem.
 *
 * Why: CalGames 2026 Q13. The auto's first state change took the drum 0.12 s after enable and cancelled the hood's
 * zero, so the hood ran unzeroed all of auto. The sim shows the same thing on a laptop (2026-10-21).
 */

import { describeCommand, isEnabled, signature, type CommandRef, type Lifetime, type Period, type RunRecord } from '../events.ts'
import type { Zero } from '../scenario.ts'
import { duration, runsLabel, type Check, type Finding, type RunResult } from './types.ts'

/** Measured: the zero's command finishes 12–38 ms after its done message prints (n = 17, 26Off, 2026-10-21). */
const FINISHES_AFTER_MESSAGE_SECONDS = 0.1
const ONE_LOOP_SECONDS = 0.02
/** Disabling interrupts running commands in the next loop (measured: 0.01–0.02 s after the disable step). */
const DISABLE_SECONDS = 0.1

export const zeroes: Check = ({ results, zeroes }) => zeroes.flatMap((zero) => {
  const zeroCommand = findZeroCommand(results, zero)
  const findings: Finding[] = []
  for (const r of results) {
    const done = doneTimes(r.record, zero)
    const tries = zeroCommand ? r.record.lives.filter((l) => signature(l.command) === zeroCommand) : []
    const undone = tries.filter((l) => !done.some((d) => d >= l.start && d <= l.end + FINISHES_AFTER_MESSAGE_SECONDS))
    findings.push(...undone.map((tried) => notDone(zero, tried, r)))
    // Enables the zero ran in: its command started and lasted past one loop (whether or not it finished; a zero that
    // checks it's already done ends at once), else its message printed.
    const ranIn = (p: Period) => tries.some((l) => l.start >= p.start && l.start <= p.end && l.end - l.start > ONE_LOOP_SECONDS)
    const ran = r.record.periods.filter(isEnabled).filter(ranIn).length
    const enables = Math.max(ran, enablesDone(r.record, zero))
    if (zero.once && enables > 1) {
      findings.push({
        check: 'zero/every-enable', severity: 'warning', run: r.run.label,
        message: `The ${zero.name} zero ran on ${enables} enables; your scenario file says it runs once.`,
        details: [],
        look: `what schedules the ${zero.name} zero on enable, and the flag that should stop it the second time`,
      })
    }
  }
  const everDone = results.some((r) => doneTimes(r.record, zero).length > 0)
  if (zero.fromFile && !everDone) {
    findings.push({
      check: 'zero/never-done', severity: 'warning', run: runsLabel(results.length, results.length),
      message: `${said(zero)} (the ${zero.name} zero's done message) never printed in any run.`,
      details: [],
      look: `the command that zeroes the ${zero.name}: does every step of it end?`,
    })
  }
  return findings
})

/** The zero ended without its done message: cut off by another command, or still going when the mode ended. */
function notDone(zero: Zero, tried: Lifetime, r: RunResult): Finding {
  const after = duration(tried.end - tried.start)
  const theZero = `the zero: ${describeCommand(tried.command)}`
  if (tried.how === 'interrupted' && tried.by) {
    const shared = tried.by.requirements.filter((s) => tried.command.requirements.includes(s))
    return {
      check: 'zero/cut-off', severity: 'error', run: r.run.label,
      message: `The ${zero.name} zero was cut off ${after} after it started, before ${said(zero)} printed.`,
      details: [theZero, `cut off by: ${describeCommand(tried.by)}${startedBy(r.record, tried.by)}`],
      look: `commands that need ${shared.join(', ')} and start in the same second as the zero`,
    }
  }
  return {
    check: 'zero/unfinished', severity: 'warning', run: r.run.label,
    message: `The ${zero.name} zero ${stillGoing(r.record, tried)} ${after} after it started; ${said(zero)} never printed.`,
    details: [theZero],
    look: `the ${zero.name} zero's end condition (current threshold, timeout)`,
  }
}

/** How a zero that wasn't cut off by another command ended. */
function stillGoing(record: RunRecord, tried: Lifetime): string {
  const disabled = record.periods.some((p) => p.mode === 'disabled' && Math.abs(p.start - tried.end) < DISABLE_SECONDS)
  if (tried.how === 'finished') return 'finished without printing its done message (a timeout?)'
  if (disabled) return 'was still running when the robot was disabled'
  if (tried.how === 'running') return 'was still running when the run ended'
  return 'was cancelled'
}

/** ", started by a trigger or button binding": what scheduled a command, from its start in this run. */
function startedBy(record: RunRecord, command: CommandRef): string {
  const origin = record.lives.find((l) => l.command.id === command.id)?.command.origin ?? ''
  if (!origin) return ''
  return `, started by ${origin === 'trigger' ? 'a trigger or button binding' : origin}`
}

/** The done message as a student would recognise it: "Rezeroed hood" (or "Hood zeroed"). */
function said(zero: Zero): string {
  return zero.done.source.split('|').map((m) => `"${m}"`).join(' or ')
}

/** How many enabled stretches of the run printed the zero's done message. */
export function enablesDone(record: RunRecord, zero: Zero): number {
  const done = doneTimes(record, zero)
  return record.periods.filter(isEnabled).filter((p) => done.some((d) => d >= p.start && d <= p.end)).length
}

function doneTimes(record: RunRecord, zero: Zero): number[] {
  return record.console.filter((l) => zero.done.test(l.text)).map((l) => l.t)
}

/** The zero's command, as a signature (same across runs), from the first run where its done message printed. */
function findZeroCommand(results: RunResult[], zero: Zero): string | null {
  for (const r of results) {
    for (const d of doneTimes(r.record, zero)) {
      const after = (l: Lifetime) => l.end - d
      const finishing = r.record.lives.filter((l) => l.how === 'finished' && after(l) >= 0 && after(l) <= FINISHES_AFTER_MESSAGE_SECONDS)
      const needsSubsystem = finishing.filter((l) => l.command.requirements.length > 0)
      const candidates = (needsSubsystem.length ? needsSubsystem : finishing).sort((a, b) => after(a) - after(b))
      if (candidates.length === 0) continue
      // A one-loop command (a runOnce) can finish with the zero: of those within a loop of the first, the longest.
      const tied = candidates.filter((l) => after(l) <= after(candidates[0]) + ONE_LOOP_SECONDS)
      const best = tied.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
      return signature(best.command)
    }
  }
  return null
}
