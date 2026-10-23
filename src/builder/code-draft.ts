/**
 * What the robot code adds to a draft from the logs: which current is supply and which stator, the CAN IDs, groups
 * the code builds together, and the current limits it applies. Each value says it came from the code; the student
 * confirms the draft before anything uses it.
 *
 * A log motor is the code's motor when one of its current keys is a key the code reads that motor into
 * (code-motors.ts). The code is read at one commit: when the log says the robot ran uncommitted changes, the draft says
 * so, since those changes aren't in any commit.
 */
import type { WpilogFile } from '../readers/wpilog.ts'
import type { CodeHints } from './code-hints.ts'
import { placeInLog, type CodeMotor, type PlacedCurrent } from './code-motors.ts'
import { allMotors } from './draft.ts'
import type { GroupJson, MotorJson, ProfileJson } from './json.ts'
import type { CurrentLimits } from '../profiles/types.ts'

/** Apply the code to a draft, in place. Returns what the student should know (motors the log lacks, a dirty tree). */
export function applyCode(json: ProfileJson, hints: CodeHints, log: WpilogFile, dirty: boolean): string[] {
  const placed = hints.motors.map((motor) => ({ motor, keys: placeInLog(motor, log) }))
  // A key two code motors claim tells nothing, so neither gets it, unless they are one motor built two ways (a robot
  // version per arm of a switch): the same ID on the same bus, read the same way, following the same leader. Then the
  // first stands for both. That ID's limits aren't read: a setting doesn't say which version applies it, so one
  // version's limit would pass for both.
  const claims = new Map<string, { motor: CodeMotor; keys: PlacedCurrent[] }[]>()
  for (const p of placed) for (const k of p.keys) claims.set(k.key, [...(claims.get(k.key) ?? []), p])
  const kindOf = (p: { keys: PlacedCurrent[] }, key: string) => p.keys.find((k) => k.key === key)?.kind
  const oneMotor = (key: string, ps: { motor: CodeMotor; keys: PlacedCurrent[] }[]) =>
    ps.length === 1 || (ps[0].motor.id !== null && ps.every((p) => p.motor.id === ps[0].motor.id && p.motor.bus === ps[0].motor.bus && p.motor.follows === ps[0].motor.follows && kindOf(p, key) === kindOf(ps[0], key)))
  const byKey = new Map([...claims].filter(([k, ps]) => oneMotor(k, ps)).map(([k, ps]) => [k, ps[0]]))
  const device = (m: CodeMotor) => `${m.id} on ${m.bus}`
  const twoWays = new Set([...claims].flatMap(([k, ps]) => (ps.length > 1 && oneMotor(k, ps) ? [device(ps[0].motor)] : [])))
  const sameMotor = new Map([...claims].flatMap(([k, ps]) => (oneMotor(k, ps) ? ps.slice(1).map((p) => [p.motor, ps[0].motor] as const) : [])))
  const codeOf = new Map<MotorJson, CodeMotor>()
  const notes: string[] = []

  for (const { motor } of allMotors(json)) {
    const hit = [motor.supplyCurrent, motor.statorCurrent, motor.current].map((k) => (k ? byKey.get(k) : undefined)).find(Boolean)
    if (!hit) continue
    codeOf.set(motor, hit.motor)
    const kind = hit.keys.find((k) => k.key === motor.current)?.kind
    if (motor.current && kind === 'torque') notes.push(`${motor.current} is a torque current (the code reads getTorqueCurrent): neither supply nor stator, so leave it unpicked.`)
    if (motor.current && kind === 'supply' && !motor.supplyCurrent) { motor.supplyCurrent = motor.current; delete motor.current; motor.kindFrom = 'code' }
    if (motor.current && kind === 'stator' && !motor.statorCurrent) { motor.statorCurrent = motor.current; delete motor.current; motor.kindFrom = 'code' }
    if (hit.motor.id !== null && (motor.canIdFrom === undefined || motor.canIdFrom === 'code hint')) { motor.canId = hit.motor.id; motor.canIdFrom = 'code' }
  }

  regroup(json, codeOf)
  for (const g of json.motorGroups) {
    const builtTwoWays = g.motors.some((m) => codeOf.has(m) && twoWays.has(device(codeOf.get(m)!)))
    const limits = builtTwoWays ? 'the code builds it in more than one robot version, and a setting doesn\'t say which version applies it' : limitsFromCode(g, codeOf, hints)
    if (typeof limits !== 'string') { if (!g.limits?.where.startsWith('as running')) { g.limits = limits; g.limitsFromCode = true } }
    else if (g.motors.some((m) => codeOf.has(m))) g.limitsWhy = limits
  }

  // One line per motor: a site and ID reached along two chains of calls is still one motor. A motor whose keys are in
  // the log isn't missing from it, even when they couldn't be told apart from another motor's.
  const label = (m: CodeMotor) => `${m.site}${m.id !== null ? ` (ID ${m.id})` : ''}`
  const matched = new Set(codeOf.values())
  const matchedLabels = new Set([...matched].map(label))
  const unmatched = [...new Set(placed.filter((p) => !p.keys.length && !matched.has(p.motor) && !matched.has(sameMotor.get(p.motor)!)).map((p) => label(p.motor)))].filter((l) => !matchedLabels.has(l))
  if (unmatched.length) notes.push(`The code builds ${unmatched.length} more Talon FX that this log has no current for: ${unmatched.join(', ')}. Their current isn't in the battery model.`)
  for (const [key, ps] of claims) {
    if (oneMotor(key, ps)) continue
    const ids = [...new Set(ps.map((p) => (p.motor.id === null ? 'no ID' : `ID ${p.motor.id}`)))]
    notes.push(`${key} is read from ${ps.length} motors in the code (${[...new Set(ps.map((p) => label(p.motor)))].join(', ')})${ids.length > 1 ? `, as ${ids.join(' and ')}` : ''}: pick its CAN ID by hand.`)
  }
  if (dirty) notes.push(`The robot ran uncommitted changes on top of ${hints.sha?.slice(0, 7) ?? 'its commit'}: this draft is from the commit, so check what the changes touched.`)
  return notes
}

/**
 * Groups as the code builds them: the motors one place builds for one folder (four modules' drive motors), and a
 * follower with its leader. Log groups the code splits are merged (grouped by the code), and a group the code agrees
 * with says so (groupFromCode), keeping the log's evidence for it. A
 * follower's group is ticked "same loop", as a suggestion the student confirms.
 */
function regroup(json: ProfileJson, codeOf: Map<MotorJson, CodeMotor>): void {
  const groupOf = (m: MotorJson) => json.motorGroups.find((g) => g.motors.includes(m))!
  const byCode = new Map<string, MotorJson[]>()
  for (const [m, c] of codeOf) byCode.set(c.group, [...(byCode.get(c.group) ?? []), m])
  for (const members of byCode.values()) {
    const target = groupOf(members[0])
    for (const m of members.slice(1)) {
      const from = groupOf(m)
      if (from === target) continue
      from.motors = from.motors.filter((x) => x !== m)
      target.motors.push(m)
      target.groupedBy = 'code'
      target.groupFromCode = true
    }
  }
  json.motorGroups = json.motorGroups.filter((g) => g.motors.length > 0)
  for (const g of json.motorGroups) {
    const codes = g.motors.map((m) => codeOf.get(m))
    if (codes.every((c) => c && c.group === codes[0]!.group)) g.groupFromCode = true
    if (codes.some((c) => c?.follows)) { g.sameLoop = true; g.sameLoopSuggested = true; g.followerFromCode = true }
  }
}

/** The limits the code gives every motor of a group, when they agree; otherwise why it gives none (for the student). */
function limitsFromCode(g: GroupJson, codeOf: Map<MotorJson, CodeMotor>, hints: CodeHints): CurrentLimits | string {
  const each = g.motors.map((m) => {
    const c = codeOf.get(m)
    return c && c.id !== null ? hints.settings.filter((s) => s.kind === 'TalonFX' && s.id === c.id && s.bus === c.bus && /Current/.test(s.field)) : null
  })
  if (each.some((s) => !s)) return 'the builder couldn\'t tell which motor in the code each one is, or its CAN ID'
  if (each.some((s) => s!.length === 0)) return 'the code sets no current limits on it that the builder can read'
  const value = (f: string) => {
    const values = each.map((s) => [...new Set(s!.filter((x) => x.field === f).map((x) => x.value))])
    return values.every((v) => v.length === 1 && v[0] === values[0][0]) ? values[0][0] : values.every((v) => v.length === 0) ? undefined : null
  }
  const fields = {
    supplyA: value('SupplyCurrentLimit'), supplyEnabled: value('SupplyCurrentLimitEnable'), statorA: value('StatorCurrentLimit'), statorEnabled: value('StatorCurrentLimitEnable'),
    supplyLowerA: value('SupplyCurrentLowerLimit'), supplyLowerSeconds: value('SupplyCurrentLowerTime'),
  }
  if (Object.values(fields).includes(null)) {
    // One motor's CAN ID given two values of one field (another robot version's subsystem, say), or motors that differ.
    const twoValues = each.some((s) => new Set(s!.map((x) => x.field)).size < new Set(s!.map((x) => `${x.field}=${x.value}`)).size)
    return twoValues ? 'the code sets different limits for its CAN ID in different places' : 'the code gives its motors different limits'
  }
  const where = lines(each.flat().map((s) => s!.where))
  const supplyLines = lines(each.flat().filter((s) => s!.field.startsWith('Supply')).map((s) => s!.where))
  return {
    ...(fields.supplyA !== undefined ? { supplyA: fields.supplyA as number } : {}),
    ...(fields.supplyEnabled !== undefined ? { supplyEnabled: fields.supplyEnabled as boolean } : {}),
    ...(fields.statorA !== undefined ? { statorA: fields.statorA as number } : {}),
    ...(fields.statorEnabled !== undefined ? { statorEnabled: fields.statorEnabled as boolean } : {}),
    ...(fields.supplyLowerA !== undefined ? { supplyLowerA: fields.supplyLowerA as number } : {}),
    ...(fields.supplyLowerSeconds !== undefined ? { supplyLowerSeconds: fields.supplyLowerSeconds as number } : {}),
    where,
    ...(supplyLines ? { supplyLines } : {}),
  }
}

/** "ElevatorIOReal.java:59", "…:60", "Robot.java:608" → "ElevatorIOReal.java:59-60, Robot.java:608". */
export function lines(wheres: string[]): string {
  const byFile = new Map<string, number[]>()
  for (const w of wheres) {
    const [file, line] = w.split(':')
    byFile.set(file, [...new Set([...(byFile.get(file) ?? []), Number(line)])].sort((a, b) => a - b))
  }
  return [...byFile].map(([file, ls]) => {
    const runs: string[] = []
    for (let i = 0; i < ls.length; i++) {
      let j = i
      while (j + 1 < ls.length && ls[j + 1] === ls[j] + 1) j++
      runs.push(i === j ? `${ls[i]}` : `${ls[i]}-${ls[j]}`)
      i = j
    }
    return `${file}:${runs.join(',')}`
  }).join(', ')
}
