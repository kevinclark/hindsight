/**
 * Motor groups from motor paths alone. One group per motor, merged only on clear evidence:
 *  - a swerve layout: the same motor name (`Drive`, `Turn`, `moveMotor`) in 3 or more sibling folders under one
 *    parent, where the folders differ only by a number or a corner (`Module0..3`, `Front Left Module`, `frontLeft`);
 *  - leader and followers: `Leader` / `Lead` / `Follower N` / `Follow` in the motors' names, in one folder.
 * Everything else (merge, split, rename) is the student's call: groups carry current limits and "same loop", which a
 * log can't show.
 */
import type { LogMotor } from './motors.ts'

export interface DraftGroup {
  name: string
  motors: { name: string; motor: LogMotor }[]
  /** Why these motors are one group. */
  evidence: 'swerve' | 'leader/follower' | 'one motor'
}

const CORNERS = new Set(['front', 'back', 'rear', 'left', 'right', 'fl', 'fr', 'bl', 'br', 'rl', 'rr'])
const ROLES = new Set(['lead', 'leader', 'follow', 'follower'])

/** "frontLeftModule" / "Front Left Module" / "Follower 0" / "FL" → lower-case words and numbers. */
export function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

/** Words for a person: "moveMotor" → "Move motor", "Roller Leader" → "Roller leader". Acronyms stay. */
export function humanize(s: string): string {
  const words = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .split(/[\s_\-/]+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) ? w : w.toLowerCase()))
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Words that name no mechanism: a tail made only of these ("motor") takes one more segment. */
const GENERIC_TAIL = new Set(['motor', 'talon', 'talonfx', 'io', 'inputs', 'hardware'])

const segments = (path: string) => path.replace(/^NT:/, '').split('/').filter(Boolean)

/** The shortest tail of each path that no other path shares, as words. */
function shortNames(paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of paths) {
    const segs = segments(p)
    for (let n = 1; n <= segs.length; n++) {
      const tail = segs.slice(-n).join('/')
      if (n < segs.length && tokens(segs.slice(-n).join(' ')).every((t) => GENERIC_TAIL.has(t))) continue
      if (n === segs.length || paths.filter((q) => q !== p && segments(q).slice(-n).join('/') === tail).length === 0) {
        out.set(p, humanize(segs.slice(-n).join(' ')))
        break
      }
    }
  }
  return out
}

export function groupMotors(motors: LogMotor[]): DraftGroup[] {
  const groups: DraftGroup[] = []
  const used = new Set<LogMotor>()

  // Swerve: <G>/<X_i>/<T>, the same T in 3+ X_i that differ only by a number or a corner word.
  const template = (x: string) => tokens(x).filter((t) => !CORNERS.has(t)).map((t) => (/^\d+$/.test(t) ? '#' : t)).join(' ')
  const candidates = new Map<string, LogMotor[]>()
  for (const m of motors) {
    const segs = segments(m.path)
    if (segs.length < 3) continue // the parent G must not be the log's root
    const g = segs.slice(0, -2).join('/'), x = segs[segs.length - 2], t = segs[segs.length - 1]
    const k = JSON.stringify([m.path.startsWith('NT:'), g, template(x), t])
    if (!candidates.has(k)) candidates.set(k, [])
    candidates.get(k)!.push(m)
  }
  for (const [k, ms] of candidates) {
    const t = (JSON.parse(k) as string[])[3]
    const xs = new Set(ms.map((m) => segments(m.path).at(-2)))
    if (ms.length < 3 || xs.size !== ms.length) continue
    const sorted = [...ms].sort((a, b) => a.path.localeCompare(b.path))
    groups.push({ name: humanize(t), evidence: 'swerve', motors: sorted.map((m) => ({ name: humanize(`${segments(m.path).at(-2)} ${t}`), motor: m })) })
    ms.forEach((m) => used.add(m))
  }

  // Leader / follower, within one folder.
  const rest = motors.filter((m) => !used.has(m))
  const folderOf = (m: LogMotor) => segments(m.path).slice(0, -1).join('/')
  const leafOf = (m: LogMotor) => segments(m.path).at(-1)!
  const role = (m: LogMotor) => { const ts = tokens(leafOf(m)); return ts.some((t) => t === 'lead' || t === 'leader') ? 'leader' : ts.some((t) => t === 'follow' || t === 'follower') ? 'follower' : null }
  const base = (m: LogMotor) => tokens(leafOf(m)).filter((t) => !ROLES.has(t) && !/^\d+$/.test(t))
  const folders = new Map<string, LogMotor[]>()
  for (const m of rest) { const f = folderOf(m); if (!folders.has(f)) folders.set(f, []); folders.get(f)!.push(m) }
  for (const [folder, ms] of folders) {
    const leaders = ms.filter((m) => role(m) === 'leader')
    const followers = ms.filter((m) => role(m) === 'follower')
    if (!leaders.length || !followers.length) continue
    const teams = new Map<LogMotor, LogMotor[]>(leaders.map((l) => [l, []]))
    for (const f of followers) {
      if (leaders.length === 1) { teams.get(leaders[0])!.push(f); continue }
      const score = (l: LogMotor) => base(l).filter((t) => base(f).includes(t)).length
      const ranked = leaders.map((l) => ({ l, s: score(l) })).sort((a, b) => b.s - a.s)
      if (ranked[0].s > 0 && ranked[0].s > ranked[1].s) teams.get(ranked[0].l)!.push(f)
    }
    for (const [leader, fs] of teams) {
      if (!fs.length) continue
      const members = [leader, ...fs]
      // The words every member shares ("kicker" in KickerLeader / KickerFollower) name the group within its folder.
      const shared = base(leader).filter((t) => fs.every((f) => base(f).includes(t)))
      const name = humanize([segments(folder).at(-1) ?? '', ...shared].join(' ')) || humanize(leafOf(leader))
      groups.push({ name, evidence: 'leader/follower', motors: members.map((m) => ({ name: humanize(`${name} ${tokens(leafOf(m)).filter((t) => !shared.includes(t)).join(' ')}`), motor: m })) })
      members.forEach((m) => used.add(m))
    }
  }

  // One group per remaining motor, named by the shortest unique tail of its path.
  const singles = motors.filter((m) => !used.has(m))
  const names = shortNames(motors.map((m) => m.path))
  for (const m of singles) groups.push({ name: names.get(m.path)!, evidence: 'one motor', motors: [{ name: names.get(m.path)!, motor: m }] })
  // Group names must differ (rules and findings name a group by it): a repeated name gets its folder in front.
  for (const g of groups) {
    const same = groups.filter((o) => o.name === g.name)
    if (same.length > 1) for (const o of same) o.name = humanize(`${segments(o.motors[0].motor.path).slice(-3, -1).join(' ')} ${o.name}`)
  }
  // The folder may not tell them apart either: number what is still repeated.
  const seen = new Set<string>()
  for (const g of groups) {
    let name = g.name
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${g.name} ${n}`
    g.name = name
    seen.add(name.toLowerCase())
  }
  return groups
}
