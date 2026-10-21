/**
 * The team's own expectations, written on a press in its scenario file: a message prints, the commands the press
 * started finish, or a logged value becomes something, each within some seconds of the press.
 */

import { readValues } from '../../readers/wpilog.ts'
import { describeCommand, markerTime, type Lifetime } from '../events.ts'
import type { Expectation, Press } from '../scenario.ts'
import { duration, type Check, type Finding, type RunResult } from './types.ts'

/** Commands that start within this long after a press were started by it (measured: same loop, under 0.03 s). */
const STARTED_BY_PRESS_SECONDS = 0.1

export const expectations: Check = ({ results }) => results.flatMap((r) =>
  r.run.scenario.steps.flatMap((s) => s.presses).flatMap((press) => {
    const pressedAt = markerTime(r.record, press.marker)
    if (pressedAt === null) return []
    return press.expect.flatMap((e) => missed(e, press, pressedAt, r))
  }))

/** The finding when the expectation wasn't met, else nothing. */
function missed(e: Expectation, press: Press, pressedAt: number, r: RunResult): Finding[] {
  const by = pressedAt + e.within
  const run = r.run.label
  if ('message' in e) {
    const printed = r.record.console.some((l) => l.t >= pressedAt && l.t <= by && l.text.includes(e.message))
    if (printed) return []
    return [{
      check: 'expect/message', severity: 'error', run,
      message: `"${e.message}" didn't print within ${duration(e.within)} after ${press.said}.`,
      details: [],
      look: `the command ${press.said} starts, and whether each of its steps ends`,
    }]
  }
  if ('finish' in e) {
    const started = r.record.lives.filter((l) => !l.command.isDefault && l.start >= pressedAt && l.start <= pressedAt + STARTED_BY_PRESS_SECONDS)
    const unfinished = started.filter((l) => l.how !== 'finished' || l.end > by)
    if (unfinished.length === 0) return []
    return [{
      check: 'expect/finish', severity: 'error', run,
      message: `${unfinished.length === 1 ? 'A command' : `${unfinished.length} commands`} ${press.said} started didn't finish within ${duration(e.within)}.`,
      details: unfinished.map((l) => `${describeCommand(l.command)}: ${howItEnded(l)}`),
      look: 'a step in the command that never ends (a run() before an until(), a wait on a condition that never comes true)',
    }]
  }
  const values = r.log ? readValues(r.log, e.key) : null
  if (!values) {
    const why = r.log ? "it isn't in the log" : 'no log was recorded'
    return [{ check: 'expect/key', severity: 'warning', run, message: `Couldn't check ${e.key}: ${why}.`, details: [] }]
  }
  const reached = values.t.some((t, i) => t >= pressedAt && t <= by && values.v[i] === e.becomes)
  if (reached) return []
  const last = values.v.filter((_, i) => values.t[i] <= by).at(-1)
  return [{
    check: 'expect/key', severity: 'error', run,
    message: `${e.key} didn't become ${JSON.stringify(e.becomes)} within ${duration(e.within)} after ${press.said} (it was ${JSON.stringify(last)}).`,
    details: [],
  }]
}

function howItEnded(l: Lifetime): string {
  if (l.how === 'running') return 'still running'
  if (l.how === 'interrupted') return `stopped after ${duration(l.end - l.start)} without finishing`
  return `finished after ${duration(l.end - l.start)}`
}
