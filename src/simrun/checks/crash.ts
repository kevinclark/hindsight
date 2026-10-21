/**
 * The robot program crashed: it stopped before the scenario ended, or never finished starting. WPILib's RobotBase
 * exits with code 0 even after an exception, so the exit code says nothing; the run's missing "end" line and the
 * exception the robot printed do. Where: the first stack frames in the team's own code.
 *
 * Why: 6 null and uninitialized fixes in 8033's history, each a crash at start or in the first loops (e905be4,
 * 4b68c96, 7e6d0ef, d783ef8 and two more).
 */

import { periodAt, type ConsoleLine, type RunRecord } from '../events.ts'
import { secs, type Check, type Finding } from './types.ts'

/** "java.lang.NullPointerException: Cannot invoke ..." inside WPILib's "Unhandled exception" line, or on its own. */
const EXCEPTION = /((?:[\w$]+\.)*[\w$]*(?:Exception|Error))(?:: (.*))?$/
const CRASH_LINE = /Unhandled exception|Exception in thread/
const FRAME = /^\s*at ([\w.$<>]+)\(([^)]*)\)/
const FRAMES_SHOWN = 3

export const crash: Check = ({ results, teamPackage }) => results.flatMap((r): Finding[] => {
  const { record } = r
  if (record.ended) return []
  const when = whenItStopped(record)
  const crashLine = record.console.find((l) => CRASH_LINE.test(l.text))
  if (!crashLine) {
    return [{
      check: r.killed ? 'run/hung' : 'run/crash', severity: 'error', run: r.run.label,
      message: r.killed ? `The robot program stopped responding ${when}; sim-run stopped it at its deadline.` : `The robot program stopped ${when}, without printing an exception.`,
      details: lastLines(record.console),
      look: 'a loop that never ends, or a wait, in a constructor, robotInit or a periodic method',
    }]
  }
  const ours = teamFrames(record.console, crashLine, teamPackage)
  return [{
    check: 'run/crash', severity: 'error', run: r.run.label,
    message: `The robot program crashed ${when}: ${exceptionOf(crashLine.text)}`,
    details: ours.length ? ours.map((f, i) => `${i === 0 ? 'at' : 'called from'} ${f}`) : lastLines(record.console),
    look: ours.length ? `${ours[0]}: the first line of your code in the stack trace` : 'the stack trace the robot printed',
  }]
})

/** The first few stack frames in the team's own code after the crash line: "Camera.getName (Camera.java:120)". */
function teamFrames(console: ConsoleLine[], crashLine: ConsoleLine, teamPackage: string): string[] {
  const after = console.slice(console.indexOf(crashLine) + 1)
  const frames = after.map((l) => FRAME.exec(l.text)).filter((f) => f !== null)
  return frames.filter((f) => f[1].startsWith(teamPackage)).slice(0, FRAMES_SHOWN).map((f) => `${f[1].split('.').slice(-2).join('.')} (${f[2]})`)
}

/** "NullPointerException: Cannot invoke ...", from WPILib's "Unhandled exception ..." line. */
function exceptionOf(line: string): string {
  const exception = EXCEPTION.exec(line)
  if (!exception) return line
  const name = exception[1].split('.').pop()
  return exception[2] ? `${name}: ${exception[2]}` : `${name}`
}

/** "while starting (in the Robot constructor or robotInit)", or "4.2 s after start, in teleop". */
function whenItStopped(record: RunRecord): string {
  if (record.started === null) return 'while starting (in the Robot constructor or robotInit)'
  return `${secs(record.last - record.started)} after start, in ${periodAt(record, record.last)?.mode ?? 'disabled'}`
}

function lastLines(console: ConsoleLine[]): string[] {
  return console.slice(-6).map((l) => `last printed: ${l.text}`)
}
