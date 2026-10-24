/**
 * Is a current limit set but switched off?
 *
 * Checks: every configuration the code applies to a device it builds on the robot (device-settings.ts), for a supply or
 * stator current limit given a value while its enable flag is written false, in the same configuration. One finding
 * per enable flag, naming every device that configuration reaches. A flag never written is left alone: Phoenix 6
 * turns both limits on by default (the 26.3.0 API docs: stator 120 A, supply 70 A), and no fix in 8033's history was
 * of an unwritten flag. Phoenix 5's
 * limit configurations aren't judged either: no case in the history.
 * Not handled (device-settings.ts reads a configuration's writes without their order or reach; no case in the
 * history): a flag written false only in a method that runs later, a `config.withCurrentLimits(…)` statement that turns
 * it back on after the field write, and a shared constant configuration turned back on from another class. Each would
 * be reported as off.
 * Why: 2026-Offseason-Robot had the drum and slapdown supply limits at 40 A with their enable flags false at a 2026 offseason
 * event, where the flywheel motors drew 78-94 A each. Ten commits in 8033's repos switched such a limit back on
 * (2026-Offseason-Robot c572443 "Re-enable current limits on all mechanisms").
 */
import type { Node } from '../java.ts'
import { appliedConfigs, isPhoenix5Limit } from '../device-settings.ts'
import type { FixEdit } from '../fix-patch.ts'
import { field, parts } from '../java.ts'
import type { Project } from '../project.ts'
import { codeRule, type CodeProblem } from '../rule.ts'

const KINDS = ['Supply', 'Stator'] as const

export default codeRule({
  id: 'code/limit-switched-off',
  title: 'A current limit set but switched off',
  meaning: 'The code gives the motor a current limit and then turns that limit off, so the limit you chose never applies. With the supply limit off, the motor can pull more from the battery than you meant, a common cause of a brownout. With the stator limit off, it can pull far more current when it stalls or starts, heating the motor and loading the mechanism harder than you meant; a supply limit still on caps what it takes from the battery.',
  nextStep: 'Turn the limit on (set its enable flag to true), or delete the value if the motor really should run with no limit.',
  incident: '2026-Offseason-Robot at a 2026 offseason event: drum supply limits at 40 A switched off; the flywheel drew 78-94 A per motor',

  check(project) {
    // Keyed by place in the code: the parser gives a new object for the same flag on each read.
    const offs = new Map<string, { at: Node; kind: (typeof KINDS)[number]; amps: number; other?: number; devices: Set<string>; writes: Map<string, Node> }>()
    for (const { device, settings } of appliedConfigs(project)) {
      for (const kind of KINDS) {
        const values = settings.filter((s) => s.field === `${kind}CurrentLimit`)
        const flags = settings.filter((s) => s.field === `${kind}CurrentLimitEnable`)
        // One value and every write of the flag false, none of it in a Phoenix 5 limit configuration.
        const amps = [...new Set(values.map((s) => s.value))]
        if (amps.length !== 1 || typeof amps[0] !== 'number' || !flags.length || flags.some((s) => s.value !== false)) continue
        if ([...values, ...flags].some((s) => isPhoenix5Limit(s.at))) continue
        const at = flags[0].at
        // The other limit of the same configuration, when it is on with one value: it still holds.
        const otherKind = kind === 'Supply' ? 'Stator' : 'Supply'
        const otherAmps = [...new Set(settings.filter((s) => s.field === `${otherKind}CurrentLimit`).map((s) => s.value))]
        const otherFlags = settings.filter((s) => s.field === `${otherKind}CurrentLimitEnable`)
        const other = otherAmps.length === 1 && typeof otherAmps[0] === 'number' && otherFlags.length && otherFlags.every((s) => s.value === true) ? otherAmps[0] : undefined
        // One finding per flag and values: a flag one helper writes for motors given different limits is one per limit.
        const key = `${project.fileOf(at).path}@${at.startIndex} ${amps[0]} ${other}`
        const off = offs.get(key) ?? { at, kind, amps: amps[0], other, devices: new Set<string>(), writes: new Map<string, Node>() }
        off.devices.add(`${device.kind} ${device.id}`)
        // Every write of the flag in this configuration, by place: the fix turns each on.
        for (const s of flags) off.writes.set(`${project.fileOf(s.at).path}@${s.at.startIndex}`, s.at)
        offs.set(key, off)
      }
    }
    return [...offs.values()].map(({ at, kind, amps, other, devices, writes }): CodeProblem => {
      const otherKind = kind === 'Supply' ? 'stator' : 'supply'
      const holds = other === undefined ? '' : ` (${devices.size === 1 ? 'its' : 'their'} ${otherKind} limit, ${other} A, is on)`
      return {
        at,
        message: `${kind}CurrentLimit is set to ${amps} A but ${kind}CurrentLimitEnable is false, so ${motors([...devices])} ${devices.size === 1 ? 'runs' : 'run'} with no ${kind.toLowerCase()} limit${holds}`,
        evidence: { 'limit set (A)': amps, devices: [...devices].join(', '), [`${otherKind} limit on (A)`]: other },
        fix: fixFor(kind, [...writes.values()], project),
      }
    })
  },
})

/** "TalonFX 15 and 16", "TalonFX 7", "TalonFX 1, 2 and CANcoder 3". */
function motors(devices: string[]): string {
  const byKind = new Map<string, string[]>()
  for (const d of devices) {
    const [kind, id] = d.split(' ')
    byKind.set(kind, [...(byKind.get(kind) ?? []), id])
  }
  const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0])
  return and([...byKind].map(([kind, ids]) => `${kind} ${and(ids.sort((a, b) => Number(a) - Number(b)))}`))
}

/**
 * Turning the flag on, where every write of it is a plain `false` to change: `flag = false;`, `.withXEnable(false)`, or a
 * `false` given in a call's arguments. A flag given as a constant or any other expression is left to the student: the
 * constant may be shared, and the edit would not be certain. Then no fix is offered at all.
 */
function fixFor(kind: (typeof KINDS)[number], writes: Node[], project: Project): CodeProblem['fix'] {
  const edits: FixEdit[] = []
  for (const write of writes) {
    const literal = falseIn(write)
    const file = project.fileOf(write)
    if (!literal || file.text.slice(literal.startIndex, literal.endIndex) !== 'false') return undefined
    edits.push({ file: file.path, start: literal.startIndex, end: literal.endIndex, replacement: 'true' })
  }
  const passedIn = writes.some((w) => w.type === 'false')
  const limit = kind === 'Supply' ? 'stator' : 'supply'
  return {
    edits,
    doesNotFix: [
      `Whether the ${kind.toLowerCase()} limit's value is right for the motor: it turns on the number the code already holds.`,
      `A flag turned off again later, in another method or from a shared constant: it changes only the ${edits.length === 1 ? 'line' : 'lines'} shown, so look for other writes of ${kind}CurrentLimitEnable.`,
      `The ${limit} limit, which it does not touch.`,
      ...(passedIn ? ['A false passed in to a method: the same argument may also mean something else in that method.'] : []),
    ].join(' '),
  }
}

/** The `false` a flag write sets, or null when the write is anything else. */
function falseIn(write: Node): Node | null {
  if (write.type === 'false') return write.parent?.type === 'argument_list' ? write : null
  const value = write.type === 'assignment_expression' ? field(write, 'right') : write.type === 'method_invocation' ? (parts(write, 'arguments').length === 1 ? parts(write, 'arguments')[0] : null) : null
  return value?.type === 'false' ? value : null
}
