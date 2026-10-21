/**
 * The plain-text report a student reads: problems first, each with what happened, where and what to look at; then
 * what each run did, Hindsight's log rules, and what a simulator can't see.
 */

import { describeCommand, isEnabled } from './events.ts'
import type { Finding } from './checks/types.ts'
import type { SessionResult } from './session.ts'
import { LEFT_OUT } from './hindsight.ts'
import { plural } from '../rules/rule.ts'
import { enablesDone } from './checks/zero.ts'

const HEADINGS: Record<Finding['severity'], string> = { error: 'PROBLEMS', warning: 'WARNINGS', info: 'NOTES' }

/** Said in every report: the measured and known limits of a desktop sim. */
export const SIM_LIMITS = [
  'Commands run in a different order within one loop on a laptop than on the roboRIO: a race that one way round is fine here can go the other way on the robot.',
  'Sim ignores motor inversion and uses the same constants as the real robot, so a wrong invert or gear ratio looks fine here.',
  'Phoenix simulation runs in real time, so every scenario takes as long as it says.',
  "Loop times are this computer's, not the roboRIO's.",
  'Vision and game pieces are simulated or absent: an auto that waits for either may behave differently.',
]

export function report(result: SessionResult, title: string): string {
  const out: string[] = [title, `Built in ${result.built.buildSeconds.toFixed(0)} s. ${result.results.length} runs, ${minutes(result.results.reduce((n, r) => n + r.wallSeconds, 0))} of wall time.`, '']
  for (const severity of ['error', 'warning', 'info'] as const) {
    const findings = result.findings.filter((f) => f.severity === severity)
    if (findings.length === 0) continue
    out.push(HEADINGS[severity])
    for (const f of findings) {
      out.push(`- [${f.run}] ${f.message}`, ...f.details.map((d) => `    ${d}`))
      if (f.look) out.push(`    Look at: ${f.look}`)
    }
    out.push('')
  }
  if (result.findings.every((f) => f.severity === 'info')) out.push('No problems found in these scenarios.', '')
  out.push('WHAT EACH RUN DID')
  for (const r of result.results) {
    const lives = r.record.lives
    const cutOff = lives.filter((l) => l.how === 'interrupted' && l.by && !l.command.isDefault).length
    const enables = r.record.periods.filter(isEnabled).length
    const how = r.record.ended ? `${plural(enables, 'enable')}, ${lives.length} commands started, ${cutOff} cut off by another` : 'stopped early'
    const zeroes = result.zeroes.map((z) => `${z.name} zero done in ${enablesDone(r.record, z)} of ${enables}`)
    out.push(`- ${r.run.label}: ${[how, ...zeroes].join('; ')} (${r.wallSeconds.toFixed(0)} s)`)
  }
  if (result.hindsight.length) {
    out.push('', `HINDSIGHT'S LOG RULES (robot profile: ${result.facts?.profileName ?? 'none'}; left out: ${Object.keys(LEFT_OUT).join(', ')})`)
    for (const { finding, runs } of result.hindsight) out.push(`- ${finding.severity}: ${finding.title} (${runs.length} of ${result.results.length} runs)`)
  }
  for (const note of result.notes) out.push('', note)
  out.push('', 'WHAT A SIMULATOR CAN\'T SEE', ...SIM_LIMITS.map((l) => `- ${l}`))
  return out.join('\n')
}

/** Every run's command story, for --verbose: when each command started and how it ended. */
export function commandStory(result: SessionResult): string {
  return result.results.map((r) => [`== ${r.run.label}`, ...r.record.lives.map((l) => {
    const end = l.how === 'interrupted' ? `cut off by ${l.by ? describeCommand(l.by) : 'disable or cancel'}` : l.how
    return `${l.start.toFixed(2)}–${l.end.toFixed(2)} ${describeCommand(l.command)}${l.command.isDefault ? ' (default)' : ''}: ${end}`
  })].join('\n')).join('\n\n')
}

function minutes(seconds: number): string {
  return seconds < 90 ? `${seconds.toFixed(0)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}
