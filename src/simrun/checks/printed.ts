/** "Error at ...: message" lines the robot printed and kept running after: once per message across all runs. */

import { runsLabel, type Check } from './types.ts'

const PRINTED_ERROR = /^Error at ([^:]+): (.*)$/

export const printedErrors: Check = ({ results }) => {
  const seen = new Map<string, string[]>()
  // A run that crashed is the crash check's; its "Error at" lines are the crash.
  for (const r of results.filter((x) => x.record.ended)) {
    for (const l of r.record.console) {
      const text = l.text.trim()
      if (!PRINTED_ERROR.test(text)) continue
      const runs = seen.get(text) ?? []
      if (!runs.includes(r.run.label)) runs.push(r.run.label)
      seen.set(text, runs)
    }
  }
  return [...seen].map(([text, runs]) => ({
    check: 'robot/printed-error', severity: 'info', run: runsLabel(runs.length, results.length, runs),
    message: 'The robot code printed an error and kept running.',
    details: [text],
  }))
}
