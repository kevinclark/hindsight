/**
 * Following values through calls. Code inside a constructor or method runs once for each call that reaches it, and
 * its parameters are whatever that call passed: `new TalonFX(motorID, canBus)` in FollowerIO's constructor is
 * `new TalonFX(16, …)` when DrumSubsystem calls `new FollowerIO(16, …)`. `waysToReach` lists the chains of calls that
 * reach a piece of code; `valueAlong` works out a value along one chain; `canBothHappen` tells whether two chains can
 * both run (not when they sit in different arms of an `if`, `? :` or `switch` on the same condition).
 */
import { classAround, codeOf, enclosing, field, isInside, modifiersOf, nameOf, parts, superclassName, typeNamed, type Node } from './java.ts'
import { ROBOT_BASES } from './libraries.ts'
import { baseType, type Project } from './project.ts'
import { localNamed, typeOf } from './types.ts'
import { valueOf } from './values.ts'

/** A value worked out along a chain of calls. */
export interface Found {
  /** The number, the text of a string, or the code of an object built (`new CANBus("*")`). */
  value: number | string
  /** Where that value is written in the code: the line to change. */
  at: Node
}

/** How many calls back it follows. */
const MOST_CALLS = 6
/** More ways than this to reach one piece of code and it gives up on it ("not judged"): assumed, a guard on time. */
const MOST_WAYS = 200
const DECLARATIONS = ['constructor_declaration', 'method_declaration', 'field_declaration']
const FORKS = ['if_statement', 'ternary_expression', 'switch_block']

/**
 * Each chain of calls that reaches this code, innermost call first: `[[]]` when it runs without a call from the
 * project (the robot's constructor, a method WPILib calls), none when it never runs (a class nothing builds), and null
 * when there are too many to follow.
 */
export function waysToReach(node: Node, project: Project, calls = 0): Node[][] | null {
  const declaration = enclosing(node, DECLARATIONS)
  if (!declaration || calls >= MOST_CALLS) return [[]]
  const callers = callersOf(declaration, project)
  if (callers.length === 0) return runsUncalled(declaration, project) ? [[]] : []
  const ways: Node[][] = []
  for (const call of callers) {
    const outer = waysToReach(call, project, calls + 1)
    if (!outer) return null
    ways.push(...outer.map((chain) => [call, ...chain]))
    if (ways.length > MOST_WAYS) return null
  }
  return ways
}

/** The value of `expr` when its code is reached through `chain` (from waysToReach), or null when it can't tell. */
export function valueAlong(expr: Node | null, chain: Node[], project: Project): Found | null {
  if (!expr) return null
  const number = valueOf(expr, project)
  if (number) return { value: number.number, at: expr }
  if (expr.type === 'string_literal') return { value: expr.text.slice(1, -1), at: expr }
  if (expr.type === 'object_creation_expression') return { value: codeOf(expr), at: expr }
  const name = expr.type === 'identifier' ? expr.text : thisField(expr)
  if (!name) return null
  const local = expr.type === 'identifier' ? localNamed(expr, name) : null
  if (local?.type === 'formal_parameter') return valueAlong(argumentFor(local, chain[0], project), chain.slice(1), project)
  const set = local ? setOnce(local, enclosing(local, ['block']) ?? local) : setOnceInClass(expr, name, project)
  return set ? valueAlong(set, chain, project) : null
}

/** Can code reached by these two paths (each the places a value passed through) both run? */
export function canBothHappen(a: Node[], b: Node[]): boolean {
  return !a.some((x) => b.some((y) => inDifferentArms(x, y)))
}

/** The calls that run a constructor, method or field's starting value: `new X(…)`, `super(…)`, `x.method(…)`. */
function callersOf(declaration: Node, project: Project): Node[] {
  const cls = classAround(declaration)
  const className = cls && nameOf(cls)
  if (!cls || !className) return []
  const count = parametersOf(declaration).length
  const fits = (call: Node) => declaration.type === 'field_declaration' || argumentsOf(call).length === count
  if (declaration.type === 'method_declaration') {
    const method = nameOf(declaration)
    return project.nodes('method_invocation').filter((call) => nameOf(call) === method && fits(call) && callsInto(call, cls, project))
  }
  const creates = project.nodes('object_creation_expression').filter((n) => baseType(typeNamed(n)) === className && fits(n))
  const supers = project.nodes('explicit_constructor_invocation').filter((n) => superclassOf(n) === className && fits(n))
  return [...creates, ...supers]
}

/** Does this call go to a method of `cls`: `Cls.method()`, `this.method()`, `method()` inside it, or on a value of its type? */
function callsInto(call: Node, cls: Node, project: Project): boolean {
  const receiver = field(call, 'object')
  const isCls = (c: Node) => c.equals(cls)
  if (!receiver || receiver.type === 'this') return project.lineage(classAround(call)).some(isCls)
  return receiver.text === nameOf(cls) || project.lineage(project.classNamed(typeOf(receiver, project))).some(isCls)
}

/**
 * Code nothing in the project calls still runs when it is a method (WPILib calls robotPeriodic), a static field, the
 * robot class (WPILib builds it: `Robot::new`), or a class with subclasses (built through them). Otherwise the class
 * is never built: an old IO class left in the code.
 */
function runsUncalled(declaration: Node, project: Project): boolean {
  const cls = classAround(declaration)
  const name = cls && nameOf(cls)
  if (!cls || !name || declaration.type === 'method_declaration' || modifiersOf(declaration).includes('static')) return true
  if (ROBOT_BASES.includes(superclassName(project.lineage(cls).at(-1) ?? cls) ?? '')) return true
  const builtByReference = project.nodes('method_reference').some((r) => r.text.replace(/\s+/g, '') === `${name}::new`)
  return builtByReference || project.nodes('class_declaration').some((c) => superclassName(c) === name)
}

/** What `call` passes for a parameter of the constructor or method it calls; null when it calls something else. */
function argumentFor(parameter: Node, call: Node | undefined, project: Project): Node | null {
  const declaration = enclosing(parameter, ['constructor_declaration', 'method_declaration'])
  if (!call || !declaration || !callersOf(declaration, project).some((c) => c.equals(call))) return null
  const parameters = parametersOf(declaration)
  const passed = argumentsOf(call)
  return passed.length === parameters.length ? (passed[parameters.findIndex((p) => p.equals(parameter))] ?? null) : null
}

/** The one value a local ever gets (its starting value, when nothing assigns it again), or null. */
function setOnce(declared: Node, scope: Node): Node | null {
  const start = field(declared, 'value')
  const name = nameOf(declared)
  const assigned = scope.descendantsOfType('assignment_expression').some((a) => a && nameOf(field(a, 'left') ?? a) === name)
  return start && !assigned ? start : null
}

/** The one value a field ever gets in its class: its starting value, or a single `this.canBus = canBus`. */
function setOnceInClass(use: Node, name: string, project: Project): Node | null {
  const [declared] = project.membersNamed(classAround(use), 'field_declaration', name)
  const body = declared && enclosing(declared, ['class_body', 'interface_body'])
  if (!body) return null
  const writes = body.descendantsOfType('assignment_expression').flatMap((a) => {
    const target = a && field(a, 'left')
    return target && (target.text === name || thisField(target) === name) ? [field(a, 'right')] : []
  })
  const values = [field(declared, 'value'), ...writes].filter((v) => v !== null)
  return values.length === 1 ? values[0] : null
}

/** The field name in `this.name`, or null. */
const thisField = (node: Node) => (node.type === 'field_access' && field(node, 'object')?.type === 'this' ? (field(node, 'field')?.text ?? null) : null)
const parametersOf = (declaration: Node) => parts(declaration, 'parameters').filter((p) => p.type === 'formal_parameter')
const argumentsOf = (call: Node) => parts(call, 'arguments')

/** The class a `super(…)` call goes to: the superclass of the class it is in. */
function superclassOf(call: Node): string | null {
  return call.text.startsWith('super') ? superclassName(classAround(call)) : null
}

/** Are x and y in different arms of forks on the same condition (one `? :`, or two that test the same thing)? */
function inDifferentArms(x: Node, y: Node): boolean {
  const armsOfY = armsAround(y)
  return armsAround(x).some((ax) => armsOfY.some((ay) => ax.condition === ay.condition && ax.arm !== ay.arm))
}

/** Every fork around a node: what it tests, and which arm the node is in ('then', 'else', or a switch's case labels). */
function armsAround(node: Node): { condition: string; arm: string }[] {
  const arms: { condition: string; arm: string }[] = []
  for (let fork = enclosing(node, FORKS); fork; fork = enclosing(fork, FORKS)) {
    const arm = armOf(node, fork)
    const owner = fork.type === 'switch_block' ? fork.parent : fork
    const condition = owner && field(owner, 'condition')
    if (!arm || !condition) continue
    // `if (!isReal())` is the other arm of `if (isReal())`.
    const tested = codeOf(condition).replace(/^\((.*)\)$/, '$1')
    const negated = /^!\s*[\w.()]+$/.test(tested)
    const flipped = arm === 'then' ? 'else' : arm === 'else' ? 'then' : arm
    arms.push(negated ? { condition: tested.replace(/^!\s*/, ''), arm: flipped } : { condition: tested, arm })
  }
  return arms
}

function armOf(node: Node, fork: Node): string | null {
  if (fork.type === 'switch_block') {
    const group = parts(fork).find((g) => isInside(node, g))
    return group ? parts(group).filter((c) => c.type === 'switch_label').map((c) => c.text).join(' ') : null
  }
  const then = field(fork, 'consequence')
  const otherwise = field(fork, 'alternative')
  if (then && isInside(node, then)) return 'then'
  return otherwise && isInside(node, otherwise) ? 'else' : null
}
