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
import { BODIES, classAround, enclosing, field, fills, isInside, lineOf, nameOf, parts, type Node } from '../java.ts'
import { baseType, type Project } from '../project.ts'
import { codeRule, plural, type CodeProblem } from '../rule.ts'
import { declarationOf, declaredType, scopeOf } from '../types.ts'
import { valueOf } from '../values.ts'

const SIGNAL_TYPES = ['StatusSignal', 'StatusSignalValue', 'BaseStatusSignal']
const READS = ['getValue', 'getValueAsDouble']
/** BaseStatusSignal's own methods that take signals: these read their cached values; isAllGood only checks them. */
const READ_ALL = ['getLatencyCompensatedValue', 'getLatencyCompensatedValueAsDouble']
const CHECK_ALL = ['isAllGood']
/** Called on the signal: refresh it now. */
const REFRESHES = ['refresh', 'waitForUpdate']
/** Called with the signals as arguments: refresh them all. */
const REFRESH_ALL = ['refreshAll', 'waitForAll']
const RATE = 'setUpdateFrequency'
const METHODS = ['method_declaration', 'constructor_declaration']
const RATE_ALL = 'setUpdateFrequencyForAll'
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
    return [...groupedByClass(problems)].map(([, group]) => said(group))
  },
})

interface Use {
  reads: Node[]
  refreshed: boolean
  rates: Node[]
  handedOff: boolean
  /** Methods that fetch it again from its device (`signal = motor.getVelocity()`): a getter refreshes. */
  fetchedIn: Node[]
}
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

/** Everything done with a signal (or an array holding it) where it can be seen: its class, or its block. */
function usesOf(declared: Node, project: Project): Use {
  const scope = declared.parent?.type === 'field_declaration' ? enclosing(declared, BODIES) : scopeOf(declared)
  const use: Use = { reads: [], refreshed: false, rates: [], handedOff: false, fetchedIn: [] }
  for (const mention of mentionsOf(declared, scope, project)) addUse(use, mention, project)
  return use
}

/** Each place the code means this variable: `name` or `this.name`, matched by declaration. */
function mentionsOf(declared: Node, scope: Node | null, project: Project): Node[] {
  const name = nameOf(declared)
  return (scope?.descendantsOfType('identifier') ?? []).flatMap((id) => {
    if (!id || id.text !== name || fills(id, 'name')) return []
    const viaThis = id.parent?.type === 'field_access' && field(id.parent, 'object')?.type === 'this'
    if (fills(id, 'field') && !viaThis) return []
    const found = viaThis ? project.membersNamed(classAround(id), 'field', id.text)[0] : declarationOf(id, id.text, project)
    return found?.equals(declared) ? [viaThis ? id.parent! : id] : []
  })
}

/** What one mention does: reads it, refreshes it, sets its rate, or hands it to other code. */
function addUse(use: Use, mention: Node, project: Project): void {
  const parent = mention.parent
  if (parent?.type === 'method_invocation' && fills(mention, 'object')) {
    const method = nameOf(parent) ?? ''
    if (READS.includes(method)) use.reads.push(parent)
    if (REFRESHES.includes(method)) use.refreshed = true
    if (method === RATE) use.rates.push(...parts(parent, 'arguments').slice(0, 1))
    return
  }
  if (parent?.type === 'array_initializer') return arrayUses(use, parent, project)
  if (parent?.type === 'assignment_expression' && fills(mention, 'left') && field(parent, 'right')?.type === 'method_invocation') {
    const method = enclosing(parent, METHODS)
    if (method?.type === 'method_declaration') use.fetchedIn.push(method)
    return
  }
  if (parent?.type !== 'argument_list') {
    use.handedOff ||= parent?.type === 'return_statement' || (parent?.type === 'assignment_expression' && fills(mention, 'right'))
    return
  }
  const call = parent.parent
  const method = call?.type === 'method_invocation' ? nameOf(call) ?? '' : ''
  const [first] = parts(parent)
  if (REFRESH_ALL.includes(method)) use.refreshed = true
  else if (READ_ALL.includes(method)) use.reads.push(call!)
  else if (CHECK_ALL.includes(method)) return
  else if (method === RATE_ALL && !first.equals(mention)) use.rates.push(first)
  else use.handedOff = true
}

/** A signal inside `new BaseStatusSignal[] {a, b}`: what is done with the array counts for the signal. */
function arrayUses(use: Use, initializer: Node, project: Project): void {
  const array = initializer.parent?.type === 'array_creation_expression' ? initializer.parent : initializer
  const holder = array.parent
  if (holder?.type === 'argument_list') return addUse(use, array, project)
  const variable = holder?.type === 'variable_declarator' ? holder : arrayVariable(holder, project)
  if (!variable) {
    use.handedOff = true
    return
  }
  const scope = variable.parent?.type === 'field_declaration' ? enclosing(variable, BODIES) : scopeOf(variable)
  for (const mention of mentionsOf(variable, scope, project)) addUse(use, mention, project)
}

/** The variable an array is assigned to (`signals = new BaseStatusSignal[] {..}`), by its declaration. */
function arrayVariable(assignment: Node | null, project: Project): Node | null {
  const target = assignment?.type === 'assignment_expression' ? field(assignment, 'left') : null
  const name = target?.type === 'field_access' ? field(target, 'field') : target
  if (!target || name?.type !== 'identifier') return null
  return target.type === 'field_access' ? project.membersNamed(classAround(target), 'field', name.text)[0] ?? null : declarationOf(name, name.text, project)
}

/**
 * The `optimizeBusUtilization()` call (or `…ForAll(.., device, ..)`) that slows the signal this getter gave, when no
 * rate call names the getter again (`setUpdateFrequencyForAll(50, motor.getVelocity(), ..)` gives the same signal a
 * rate). A temperature is left alone: it changes over seconds, so 4 a second is plenty.
 */
function slowedBy(getter: Node, project: Project): Node | null {
  const method = nameOf(getter) ?? ''
  const device = deviceOf(getter, project)
  if (!device || SLOW_ENOUGH.includes(method)) return null
  const isDevice = (n: Node | null) => !!n && n.type === 'identifier' && declarationOf(n, n.text, project)?.equals(device) === true
  const isSameGetter = (n: Node) => n.type === 'method_invocation' && nameOf(n) === method && isDevice(field(n, 'object'))
  const calls = project.nodes('method_invocation')
  if (calls.some((call) => nameOf(call) === RATE_ALL && parts(call, 'arguments').some(isSameGetter))) return null
  return calls.find((call) => {
    if (nameOf(call) === OPTIMIZE) return isDevice(field(call, 'object'))
    return nameOf(call) === OPTIMIZE_ALL && parts(call, 'arguments').some(isDevice)
  }) ?? null
}

/** The getter a signal was taken from: `motor.getPosition()` in `position = motor.getPosition()`. */
function getterOf(signal: Node, project: Project): Node | null {
  const name = nameOf(signal)
  const assigned = (enclosing(signal, BODIES)?.descendantsOfType('assignment_expression') ?? []).flatMap((a) => {
    const target = a && field(a, 'left')
    const targetName = target?.type === 'field_access' ? field(target, 'field')?.text : target?.text
    return a && targetName === name ? [field(a, 'right')] : []
  })
  return [field(signal, 'value'), ...assigned].find((v): v is Node => v?.type === 'method_invocation') ?? null
}

/** The device a getter is called on (`motor`), by its declaration. */
function deviceOf(getter: Node, project: Project): Node | null {
  const device = field(getter, 'object')
  return device?.type === 'identifier' ? declarationOf(device, device.text, project) : null
}

/** Problems of one kind in one class, so a file with six unrefreshed signals gets one finding, not six. */
function groupedByClass(problems: Problem[]): Map<string, Problem[]> {
  const groups = new Map<string, Problem[]>()
  for (const p of problems) {
    const key = `${classAround(p.read)?.id} ${p.kind}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  return groups
}

/** One finding for a group of signals with the same problem, at the first read. */
function said(group: Problem[]): CodeProblem {
  const [{ kind, read, at }] = group
  const names = group.map((p) => p.name).join(', ')
  const they = group.length === 1 ? 'it was' : 'they were'
  const signals = plural(group.length, 'status signal')
  const where = at ? ` (line ${lineOf(at)})` : ''
  if (kind === 'rate 0') return { message: `${signals} set to update 0 times a second${where} and then read: ${names}. The value never changes`, at: read }
  if (kind === 'slowed') return { message: `${signals} read with no rate of ${group.length === 1 ? 'its' : 'their'} own, so optimizeBusUtilization()${where} slows ${group.length === 1 ? 'it' : 'them'} to 4 a second: ${names}`, at: read }
  return { message: `${signals} read but never refreshed: ${names}. Each read gives the value from when ${they} first fetched`, at: read }
}
