/**
 * The robots the Library offers a profile draft for: those only a Codebase text names (no built-in profile, none kept in
 * this browser), and the log a draft would start from. The button opens the profile builder with that log and "Use
 * GitHub" filled in (ProfileBuilder's start(), as the Session view's offer does); nothing uses the draft until a student
 * keeps it. No node: imports (the page uses it).
 */
import type { Entry } from './catalog.ts'
import type { CodeLink } from './types.ts'

/** Where a draft for one robot would come from. */
export type DraftSource =
  /** This log, on this computer, linked to its code: by commit when any log of the robot is, else by its Codebase text. */
  | { kind: 'draft'; entry: Entry; code: CodeLink }
  /** Logs linked to code exist, but none is on this computer. */
  | { kind: 'not here'; code: CodeLink }
  | { kind: 'no code' }

export interface RobotToProfile { name: string; logs: number; source: DraftSource }

/** Each robot only a Codebase text names, by name, leaving out those a kept profile's `codebase` names. Stubs never count. */
export function robotsToProfile(entries: Entry[], keptCodebases: ReadonlySet<string>): RobotToProfile[] {
  const byName = new Map<string, Entry[]>()
  for (const e of entries) {
    const robot = e.record.robot
    if (e.record.stub || !robot || robot.profileId !== null || !robot.name || keptCodebases.has(robot.name)) continue
    const rows = byName.get(robot.name)
    if (rows) rows.push(e); else byName.set(robot.name, [e])
  }
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => ({ name, logs: rows.length, source: sourceOf(rows) }))
}

/** The newest log linked by commit (a match on the field first), else the newest linked by name; one on this computer if any is. */
function sourceOf(rows: Entry[]): DraftSource {
  const byCommit = (e: Entry) => Number(e.record.code?.linkedBy === 'sha' && !!e.record.code.sha)
  const best = (a: Entry, b: Entry) => byCommit(b) - byCommit(a) || Number(b.record.onField) - Number(a.record.onField)
    || (b.record.playedAt ?? -Infinity) - (a.record.playedAt ?? -Infinity) || a.record.path.localeCompare(b.record.path)
  const linked = rows.filter((e) => e.record.code).sort(best)
  const here = linked.find((e) => e.local)
  if (here) return { kind: 'draft', entry: here, code: here.record.code! }
  return linked.length ? { kind: 'not here', code: linked[0].record.code! } : { kind: 'no code' }
}
