/**
 * What the code does with a Phoenix StatusSignal kept in a variable: where it reads it, whether something refreshes
 * it, the rates it is given, and whether it is handed to other code. rules/stale-signal.ts judges the answer.
 * Phoenix 6 docs, "Status Signals": a kept signal holds the value from its last refresh; a device's getter
 * (`motor.getVelocity()`) refreshes; `BaseStatusSignal.refreshAll(..)` refreshes the signals it is given.
 */
import { classAround, enclosing, field, fills, nameOf, parts, type Node } from './java.ts'
import type { Project } from './project.ts'
import { declarationOf, visibleIn } from './types.ts'

const READS = ['getValue', 'getValueAsDouble']
/** BaseStatusSignal's own methods that take signals: these read their cached values; isAllGood only checks them. */
const READ_ALL = ['getLatencyCompensatedValue', 'getLatencyCompensatedValueAsDouble']
const CHECK_ALL = ['isAllGood']
/** Called on the signal: refresh it now. */
const REFRESHES = ['refresh', 'waitForUpdate']
/** Called with the signals as arguments: refresh them all. */
const REFRESH_ALL = ['refreshAll', 'waitForAll']
export const RATE_ALL = 'setUpdateFrequencyForAll'
const RATE = 'setUpdateFrequency'
const METHODS = ['method_declaration', 'constructor_declaration']

export interface SignalUse {
  reads: Node[]
  refreshed: boolean
  /** The rates it is given (the `hz` of `setUpdateFrequency(hz)` and `setUpdateFrequencyForAll(hz, ..)`). */
  rates: Node[]
  /** Passed to other code (a method, a constructor, a return): it may be refreshed there. */
  handedOff: boolean
  /** Methods that fetch it again from its device (`signal = motor.getVelocity()`): a getter refreshes. */
  fetchedIn: Node[]
}

/** Everything done with a signal (or an array holding it) wherever its name can be used. */
export function usesOf(declared: Node, project: Project): SignalUse {
  const use: SignalUse = { reads: [], refreshed: false, rates: [], handedOff: false, fetchedIn: [] }
  for (const mention of mentionsOf(declared, project)) addUse(use, mention, project)
  return use
}

/** The getter a signal was taken from: `motor.getPosition()` in `position = motor.getPosition()`. */
export function getterOf(signal: Node, project: Project): Node | null {
  const name = nameOf(signal)
  const assigned = (visibleIn(signal)?.descendantsOfType('assignment_expression') ?? []).flatMap((a) => {
    const target = a && field(a, 'left')
    return a && target && writtenName(target) === name ? [field(a, 'right')] : []
  })
  return [field(signal, 'value'), ...assigned].find((v): v is Node => v?.type === 'method_invocation') ?? null
}

/** Each place the code means this variable: `name` or `this.name`, matched by declaration. */
function mentionsOf(declared: Node, project: Project): Node[] {
  const name = nameOf(declared)
  return (visibleIn(declared)?.descendantsOfType('identifier') ?? []).flatMap((id) => {
    if (!id || id.text !== name || fills(id, 'name')) return []
    const access = id.parent
    const viaThis = access?.type === 'field_access' && field(access, 'object')?.type === 'this'
    if (fills(id, 'field') && !viaThis) return []
    const found = viaThis ? project.membersNamed(classAround(id), 'field', id.text)[0] : declarationOf(id, id.text, project)
    if (!found?.equals(declared)) return []
    return [viaThis && access ? access : id]
  })
}

/** What one mention does: reads it, refreshes it, sets its rate, or hands it to other code. */
function addUse(use: SignalUse, mention: Node, project: Project): void {
  const parent = mention.parent
  if (parent?.type === 'method_invocation' && fills(mention, 'object')) return calledOn(use, parent)
  if (parent?.type === 'array_initializer') return arrayUses(use, parent, project)
  if (parent?.type === 'argument_list') return passedTo(use, mention, parent)
  if (parent?.type === 'assignment_expression' && fills(mention, 'left')) {
    const method = enclosing(parent, METHODS)
    if (field(parent, 'right')?.type === 'method_invocation' && method?.type === 'method_declaration') use.fetchedIn.push(method)
    return
  }
  use.handedOff ||= parent?.type === 'return_statement' || (parent?.type === 'assignment_expression' && fills(mention, 'right'))
}

/** `signal.getValue()`, `signal.refresh()`, `signal.setUpdateFrequency(hz)`. */
function calledOn(use: SignalUse, call: Node): void {
  const method = nameOf(call) ?? ''
  if (READS.includes(method)) use.reads.push(call)
  if (REFRESHES.includes(method)) use.refreshed = true
  if (method === RATE) use.rates.push(...parts(call, 'arguments').slice(0, 1))
}

/** `refreshAll(signal, ..)`, `setUpdateFrequencyForAll(hz, signal, ..)`, or any other call, which hands it off. */
function passedTo(use: SignalUse, mention: Node, argumentList: Node): void {
  const call = argumentList.parent
  const method = call?.type === 'method_invocation' ? (nameOf(call) ?? '') : ''
  const [first] = parts(argumentList)
  if (REFRESH_ALL.includes(method)) use.refreshed = true
  else if (READ_ALL.includes(method) && call) use.reads.push(call)
  else if (CHECK_ALL.includes(method)) return
  else if (method === RATE_ALL && !first.equals(mention)) use.rates.push(first)
  else use.handedOff = true
}

/** A signal inside `new BaseStatusSignal[] {a, b}`: what is done with the array counts for the signal. */
function arrayUses(use: SignalUse, initializer: Node, project: Project): void {
  const array = initializer.parent?.type === 'array_creation_expression' ? initializer.parent : initializer
  const holder = array.parent
  if (holder?.type === 'argument_list') return addUse(use, array, project)
  const variable = holder?.type === 'variable_declarator' ? holder : arrayVariable(holder, project)
  if (!variable) {
    use.handedOff = true
    return
  }
  for (const mention of mentionsOf(variable, project)) addUse(use, mention, project)
}

/** The variable an array is assigned to (`signals = new BaseStatusSignal[] {..}`), by its declaration. */
function arrayVariable(assignment: Node | null, project: Project): Node | null {
  const target = assignment?.type === 'assignment_expression' ? field(assignment, 'left') : null
  const name = target && writtenName(target)
  if (!target || !name) return null
  if (target.type === 'field_access') return project.membersNamed(classAround(target), 'field', name)[0] ?? null
  return declarationOf(target, name, project)
}

/** The name an assignment writes: `x` in `x = …` and in `this.x = …`. */
function writtenName(target: Node): string | null {
  if (target.type === 'identifier') return target.text
  return target.type === 'field_access' ? (field(target, 'field')?.text ?? null) : null
}
