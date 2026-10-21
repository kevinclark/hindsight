/**
 * Is a Phoenix status signal read without fresh data?
 *
 * Checks: a StatusSignal kept in a field or variable (`velocity = motor.getVelocity()` once, then
 * `velocity.getValueAsDouble()` every loop) and read with getValue() or getValueAsDouble(), when:
 * - nothing refreshes it: it is in no `BaseStatusSignal.refreshAll(..)` or `waitForAll(..)` (directly, or in an array
 *   passed to one), and nothing calls `.refresh()` or `.waitForUpdate()` on it;
 * - it is set to update 0 times a second (`setUpdateFrequencyForAll(0.0, ..)`): it never changes;
 * - its device's `optimizeBusUtilization()` runs and nothing gives the signal a rate of its own: Phoenix slows it
 *   to 4 updates a second (before 2025, to none).
 * The device's own getter refreshes (`motor.getVelocity().getValue()` is fresh): only a kept signal goes stale. A
 * signal handed to any other method or constructor (an odometry thread, a helper that refreshes every signal) may be
 * refreshed there, so it is left alone. Names are matched to where they are declared, so an inputs class with fields
 * of the same names isn't taken for the signals.
 * Phoenix 6 docs, "Status Signals" (Refreshing the signal value; optimizeBusUtilization).
 * Why: 2026-Offseason-Robot 2133a8c ("Forgot to refresh all"), Crescendo c77c85d, 3bcd785, 774423b and 1f202a7, and
 * Reefscape ea7d383 fixed signals that were never refreshed; 0be6bb7 and 6b1670f fixed a rate of 0; 2025-Offseason-Robot
 * bcf5654 gave signals the rate that optimizeBusUtilization had taken away.
 */
import { classAround, field, isInside, lineOf, nameOf, parts, type Node } from '../java.ts'
import { baseType, type Project } from '../project.ts'
import { codeRule, plural, type CodeProblem } from '../rule.ts'
import { getterOf, RATE_ALL, usesOf } from '../signal-uses.ts'
import { declarationOf, declaredType } from '../types.ts'
import { valueOf } from '../values.ts'
import { groupBy } from '../../../rules/run.ts'

const SIGNAL_TYPES = ['StatusSignal', 'StatusSignalValue', 'BaseStatusSignal']
const OPTIMIZE = 'optimizeBusUtilization'
const OPTIMIZE_ALL = 'optimizeBusUtilizationForAll'
/** Getters whose signal changes slowly enough that 4 updates a second lose nothing. */
const SLOW_ENOUGH = ['getDeviceTemp', 'getProcessorTemp', 'getAncillaryDeviceTemp']

export default codeRule({
  id: 'code/stale-signal',
  title: 'A status signal read without fresh data',
  meaning: 'A Phoenix StatusSignal kept in a variable holds the value from its last refresh. If nothing refreshes it (BaseStatusSignal.refreshAll), or it updates 0 times a second, every read gives the same old value: the robot code and the log see a mechanism that never moves. optimizeBusUtilization() slows every signal without its own rate to 4 a second.',
  nextStep: 'Refresh every signal you read once per loop (BaseStatusSignal.refreshAll(a, b, …) at the top of updateInputs), and give each a rate (BaseStatusSignal.setUpdateFrequencyForAll(50, a, b, …)) before optimizeBusUtilization().',
  incident: '2026-Offseason-Robot 2133a8c "Forgot to refresh all": the flywheel signals were read but never refreshed',

  check(project) {
    const signals = project.nodes('variable_declarator').filter((d) => SIGNAL_TYPES.includes(baseType(declaredType(d)) ?? ''))
    const problems = signals.flatMap((signal) => problemWith(signal, project))
    // One finding per kind of problem in a class, so a file with six unrefreshed signals gets one finding, not six.
    const byClass = groupBy(problems, (p) => `${classAround(p.read)?.id} ${p.kind}`)
    return [...byClass.values()].map(said)
  },
})

type Kind = 'never refreshed' | 'rate 0' | 'slowed'
interface Problem { kind: Kind; name: string; read: Node; at?: Node }

/** What is wrong with one signal, if it is read: never refreshed, a rate of 0, or slowed by optimizeBusUtilization. */
function problemWith(signal: Node, project: Project): Problem[] {
  const use = usesOf(signal, project)
  const name = nameOf(signal) ?? ''
  const [read] = use.reads
  if (!read || use.handedOff) return []
  const zero = use.rates.find((hz) => valueOf(hz, project)?.number === 0)
  if (zero) return [{ kind: 'rate 0', name, read, at: zero }]
  const fetchedFresh = use.reads.every((r) => use.fetchedIn.some((method) => isInside(r, method)))
  if (!use.refreshed && !fetchedFresh) return [{ kind: 'never refreshed', name, read }]
  const getter = use.rates.length === 0 ? getterOf(signal, project) : null
  const optimize = getter && slowedBy(getter, project)
  return optimize ? [{ kind: 'slowed', name, read, at: optimize }] : []
}

/**
 * The `optimizeBusUtilization()` call (or `…ForAll(.., device, ..)`) that slows the signal this getter gave, when no
 * rate call names the getter again (`setUpdateFrequencyForAll(50, motor.getVelocity(), ..)` gives the same signal a
 * rate). A temperature is left alone: it changes over seconds, so 4 a second is plenty.
 */
function slowedBy(getter: Node, project: Project): Node | null {
  const method = nameOf(getter) ?? ''
  const device = field(getter, 'object')
  const declared = device?.type === 'identifier' ? declarationOf(device, device.text, project) : null
  if (!declared || SLOW_ENOUGH.includes(method)) return null
  const isDevice = (n: Node | null) => n?.type === 'identifier' && declarationOf(n, n.text, project)?.equals(declared) === true
  const isSameGetter = (n: Node) => n.type === 'method_invocation' && nameOf(n) === method && isDevice(field(n, 'object'))
  const calls = project.nodes('method_invocation')
  if (calls.some((call) => nameOf(call) === RATE_ALL && parts(call, 'arguments').some(isSameGetter))) return null
  return calls.find((call) => {
    if (nameOf(call) === OPTIMIZE) return isDevice(field(call, 'object'))
    return nameOf(call) === OPTIMIZE_ALL && parts(call, 'arguments').some(isDevice)
  }) ?? null
}

/** One finding for a group of signals with the same problem, at the first read. */
function said(group: Problem[]): CodeProblem {
  const [{ kind, read, at }] = group
  const names = group.map((p) => p.name).join(', ')
  const signals = plural(group.length, 'status signal')
  const where = at ? ` (line ${lineOf(at)})` : ''
  const one = group.length === 1
  if (kind === 'rate 0') return { message: `${signals} set to update 0 times a second${where} and then read: ${names}. The value never changes`, at: read }
  if (kind === 'slowed') {
    const own = one ? 'its own' : 'their own'
    const optimize = at ? `${nameOf(at)}()` : 'optimizeBusUtilization()'
    return { message: `${signals} read with no rate of ${own}, so ${optimize}${where} slows ${one ? 'it' : 'them'} to 4 a second: ${names}`, at: read }
  }
  return { message: `${signals} read but never refreshed: ${names}. Each read gives the value from when ${one ? 'it was' : 'they were'} first fetched`, at: read }
}
