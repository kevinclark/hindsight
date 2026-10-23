/**
 * Following values through calls. Code inside a constructor or method runs once for each call that reaches it, and
 * its parameters are whatever that call passed: `new TalonFX(motorID, canBus)` in FollowerIO's constructor is
 * `new TalonFX(16, …)` when DrumSubsystem calls `new FollowerIO(16, …)`. `waysToReach` lists the chains of calls that
 * reach a piece of code; `valueAlong` works out a value along one chain; `canBothHappen` tells whether two chains can
 * both run (not when they sit in different arms of an `if`, `? :` or `switch` on the same condition).
 */
import { BODIES, classAround, codeOf, enclosing, field, isInside, modifiersOf, nameOf, parts, superclassName, typeNamed, type Node } from './java.ts'
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
/** What a `return` belongs to: the nearest method, constructor or lambda. */
const BODY_OWNERS = ['method_declaration', 'constructor_declaration', 'lambda_expression']

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

/**
 * The value of `expr` when its code is reached through `chain` (from waysToReach), or null when it can't tell. With
 * `throughCalls`, a call to a project method with one `return` is followed into it (`DrumSubsystem.getHoodConfig()`
 * is the `config` it returns); otherwise a call can't be told.
 */
export function valueAlong(expr: Node | null, chain: Node[], project: Project, options = { throughCalls: false }): Found | null {
  const made = madeAlong(expr, chain, project, options)
  if (!made) return null
  const number = valueOf(made.at, project)
  if (number) return { value: number.number, at: made.at }
  if (made.at.type === 'string_literal') return { value: made.at.text.slice(1, -1), at: made.at }
  if (made.at.type === 'object_creation_expression') return { value: codeOf(made.at), at: made.at }
  return null
}

/** throughCalls: follow a call into a project method's one `return`. stopAt: code to stop at, as where the value is made. */
export interface FollowOptions { throughCalls: boolean; stopAt?: (expr: Node) => boolean }

/** How many names, parameters and members one value is followed through (a cycle stops here too). */
const MOST_STEPS = 24

/**
 * Where the value of `expr` is made, reached through `chain`: a number, a string, or an object built (`new X(…)`),
 * with the chain of calls in effect there. It follows names to the one value they get, parameters to what the call
 * passed, and a member of an object the project builds to what built it: a record's component
 * (`constants.driveID()` of `new ModuleConstants(0, "Front Left", 11, …)` is 11), a field its constructor sets from a
 * parameter (`moduleConstants.angleMotorID`), or a method that returns one. Null when it can't tell.
 */
export function madeAlong(expr: Node | null, chain: Node[], project: Project, options: FollowOptions = { throughCalls: false }, steps = 0): { at: Node; chain: Node[] } | null {
  if (!expr || steps > MOST_STEPS) return null
  const along = (next: Node | null, nextChain: Node[]) => madeAlong(next, nextChain, project, options, steps + 1)
  if (valueOf(expr, project) || expr.type === 'string_literal' || expr.type === 'object_creation_expression' || isModuleConstants(expr, project) || options.stopAt?.(expr)) return { at: expr, chain }
  if (expr.type === 'parenthesized_expression') return along(parts(expr)[0] ?? null, chain)
  // `isReal ? new RollerIO(9) : new RollerIOSim(9)`: on the robot, the arm that isn't simulation.
  if (expr.type === 'ternary_expression') {
    const arms = [field(expr, 'consequence'), field(expr, 'alternative')].map((arm) => along(arm, chain))
    const real = arms.filter((a) => a && !inSimulation(a.at))
    return arms.every(Boolean) && real.length === 1 ? real[0] : null
  }
  if (expr.type === 'method_invocation' && options.throughCalls && chain.length < MOST_CALLS) {
    const returned = returnedBy(expr, project)
    if (returned) return along(returned, [expr, ...chain])
  }
  const name = expr.type === 'identifier' ? expr.text : thisField(expr)
  if (!name) return memberAlong(expr, chain, project, along)
  const local = expr.type === 'identifier' ? localNamed(expr, name) : null
  if (local?.type === 'formal_parameter') return along(argumentFor(local, chain[0], project), chain.slice(1))
  const set = local ? setOnce(local, enclosing(local, ['block']) ?? local) : setOnceInClass(expr, name, project)
  return set ? along(set, local ? chain : chainAt(set, chain, project)) : null
}

/**
 * The calls that reach a field's value, from the calls that reach where the field is used: a field set in the
 * constructor (`steerMotor = new HighlanderFalcon(moduleConstants.angleMotorID)`) and used in a method the constructor
 * calls (`configAngleMotor()`) runs under the constructor's call, so the chain starts there.
 */
function chainAt(value: Node, chain: Node[], project: Project): Node[] {
  const declaration = enclosing(value, DECLARATIONS)
  if (!declaration) return chain
  const callers = callersOf(declaration, project)
  const i = chain.findIndex((c) => callers.some((x) => x.equals(c)))
  return i >= 0 ? chain.slice(i) : chain
}

/**
 * `object.member` or `object.member()`, where the object is built in the project: what the code that built it gave
 * that member. A record's component is the argument in its place; a field is the argument its constructor stores in it
 * (`this.angleMotorID = angleMotorID`); a method with no parameters is the field it returns, or the value it makes
 * (`getFrontLeftModule()` returning `new ModuleConstants(…)`). An enum's constant (`RobotHardware.KELPIE`) is built by
 * its arguments, and a class's own field named through the class (`Constants.Swerve.Mod0.constants`) is its one
 * starting value.
 */
function memberAlong(
  expr: Node, chain: Node[], project: Project, along: (next: Node | null, chain: Node[]) => { at: Node; chain: Node[] } | null,
): { at: Node; chain: Node[] } | null {
  const isCall = expr.type === 'method_invocation'
  if (!isCall && expr.type !== 'field_access') return null
  const object = field(expr, 'object')
  const member = isCall ? nameOf(expr) : field(expr, 'field')?.text
  if (!object || !member) return null
  const ownerName = object.text.replace(/\s+/g, '')
  if (!isCall) {
    const constant = enumsNamed(ownerName, project).flatMap((e) => parts(field(e, 'body')).filter((c) => c.type === 'enum_constant' && nameOf(c) === member))
    if (constant.length === 1) return { at: constant[0], chain: [] }
    const owners = project.ownersNamed(ownerName)
    if (owners.length === 1) {
      const [declared, ...more] = project.membersNamed(owners[0], 'field', member)
      return declared && !more.length ? along(onlyValueIn(declared, member), []) : null
    }
  }
  const built = along(object, chain)
  if (built && !isCall && isModuleConstants(built.at, project)) return moduleConstant(built.at, member, built.chain, project, along)
  if (built?.at.type !== 'object_creation_expression' && built?.at.type !== 'enum_constant') return null
  const passed = argumentsOf(built.at)
  const declaration = built.at.type === 'enum_constant' ? enclosing(built.at, ['enum_declaration']) : builtClass(baseType(typeNamed(built.at)), project)
  if (!declaration) return null
  if (declaration.type === 'record_declaration') {
    const index = parametersOf(declaration).findIndex((p) => nameOf(p) === member)
    return index >= 0 && passed.length === parametersOf(declaration).length ? along(passed[index] ?? null, built.chain) : null
  }
  let fieldName: string | null = member
  if (isCall) {
    // A method with parameters is followed only to a value it makes (`getTurnConfiguration(cancoderID)` building a
    // config); what it returns of its parameters isn't (the call isn't matched to the method's parameters here).
    const count = argumentsOf(expr).length
    const returned = returnedBy0(declaration, member, count, project)
    const local = returned?.type === 'identifier' && localNamed(returned, returned.text)
    fieldName = returned?.type === 'identifier' && !local ? returned.text : returned ? thisField(returned) : null
    if (count > 0 && fieldName) return null
    if (returned && !fieldName) return along(returned, built.chain)
  }
  if (!fieldName) return null
  const constructor = constructorsOf(declaration).find((c) => parametersOf(c).length === passed.length)
  const stored = constructor ? storedIn(constructor, fieldName) : null
  if (!stored) return null
  const index = parametersOf(constructor!).findIndex((p) => p.equals(stored))
  return index >= 0 ? along(passed[index] ?? null, built.chain) : along(stored, built.chain)
}

/**
 * CTRE's swerve module constants, as Tuner X generates them: `ConstantCreator.createModuleConstants(steerMotorId,
 * driveMotorId, encoderId, …)` (Phoenix 6, the order of 2024 to 2026), from a `SwerveModuleConstantsFactory` set up with
 * `.withSlipCurrent(…)`, `.withDriveMotorInitialConfigs(…)` and the like. The robot code reads them as fields
 * (`constants.DriveMotorId`). A library call, so it is where these values are made; a project method of that name is
 * the team's own, read like any other.
 */
const MODULE_IDS: Record<string, number> = { SteerMotorId: 0, DriveMotorId: 1, EncoderId: 2, CANcoderId: 2 }
const isModuleConstants = (expr: Node, project: Project) => expr.type === 'method_invocation' && nameOf(expr) === 'createModuleConstants' && !project.methodsNamed('createModuleConstants').length
const isWithCall = (expr: Node) => expr.type === 'method_invocation' && /^with[A-Z]/.test(nameOf(expr) ?? '')

/** A field of module constants: an ID passed to createModuleConstants, or what the factory's `.with<Field>(…)` set. */
function moduleConstant(
  made: Node, member: string, chain: Node[], project: Project, along: (next: Node | null, chain: Node[]) => { at: Node; chain: Node[] } | null,
): { at: Node; chain: Node[] } | null {
  if (Object.hasOwn(MODULE_IDS, member)) return along(argumentsOf(made)[MODULE_IDS[member]] ?? null, chain)
  const factory = madeAlong(field(made, 'object'), chain, project, { throughCalls: false, stopAt: isWithCall })
  // The outermost `.with<Field>(…)` is the one that holds: each replaces what an earlier one set.
  for (let at = factory?.at ?? null; at && isWithCall(at); at = field(at, 'object')) {
    if (nameOf(at) === `with${member}`) return along(argumentsOf(at)[0] ?? null, factory!.chain)
  }
  return null
}

/**
 * Is this call simulation code: in a class whose name ends in "Sim", or building one (`new FlywheelIOSim(…, 11, 12)`)?
 * AdvantageKit's IO pattern names them so, and their IDs needn't match the robot's: Rebuilt 3eca5e5 gives the
 * simulated flywheel 11 and 12, the real hood's and flywheel's IDs.
 */
export function inSimulation(call: Node): boolean {
  const named = (name: string | null | undefined) => !!name?.endsWith('Sim')
  return named(nameOf(classAround(call) ?? call)) || (call.type === 'object_creation_expression' && named(baseType(typeNamed(call))))
}

/** The one record, or class, in the project with this name (records and enums aren't in the class index). */
function builtClass(name: string | null, project: Project): Node | null {
  const records = project.nodes('record_declaration').filter((r) => nameOf(r) === name)
  return records.length === 1 ? records[0] : project.classNamed(name)
}

const enumsNamed = (name: string, project: Project) => project.nodes('enum_declaration').filter((e) => nameOf(e) === name.split('.').pop())
const constructorsOf = (declaration: Node) =>
  declaration.descendantsOfType('constructor_declaration').filter((c): c is Node => !!c && enclosing(c, ['class_declaration', 'enum_declaration', 'record_declaration'])?.equals(declaration) === true)

/** What a method with this many parameters returns, in this class or the project classes above it: its single `return`. */
function returnedBy0(declaration: Node, method: string, count: number, project: Project): Node | null {
  const own = (d: Node) => d.descendantsOfType('method_declaration').filter((m): m is Node => !!m && nameOf(m) === method && parametersOf(m).length === count && enclosing(m, ['class_declaration', 'enum_declaration'])?.equals(d) === true)
  const getter = declaration.type === 'class_declaration' ? project.membersNamed(declaration, 'method', method).find((m) => parametersOf(m).length === count) : own(declaration)[0]
  const returns = (getter?.descendantsOfType('return_statement') ?? []).filter((r) => r && enclosing(r, BODY_OWNERS)?.equals(getter!))
  return returns.length === 1 && returns[0] ? (parts(returns[0])[0] ?? null) : null
}

/**
 * What a constructor stores in a field when it sets it once: the parameter it is set from (`this.x = x`), or the value
 * (`swerveAngleFXConfig = new TalonFXConfiguration()`).
 */
function storedIn(constructor: Node, fieldName: string): Node | null {
  const writes = constructor.descendantsOfType('assignment_expression').filter((a) => {
    const target = a && field(a, 'left')
    return target && (thisField(target) === fieldName || (target.type === 'identifier' && target.text === fieldName && !localNamed(target, fieldName)))
  })
  const value = writes.length === 1 && writes[0] ? field(writes[0], 'right') : null
  const local = value?.type === 'identifier' ? localNamed(value, value.text) : null
  return local?.type === 'formal_parameter' ? local : value
}

/** What the one project method a call goes to returns, when it has a single `return`; null when it can't tell. */
function returnedBy(call: Node, project: Project): Node | null {
  const goesTo = (m: Node) => parametersOf(m).length === argumentsOf(call).length && callsInto(call, classAround(m) ?? m, project)
  const methods = project.methodsNamed(nameOf(call) ?? '').filter(goesTo)
  if (methods.length !== 1) return null
  const returns = methods[0].descendantsOfType('return_statement').filter((r) => r && enclosing(r, BODY_OWNERS)?.equals(methods[0]))
  return returns.length === 1 ? (parts(returns[0])[0] ?? null) : null
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
  return start && !assigned && !stepped(scope, (target) => target.text === name) ? start : null
}

/** Is a name stepped up or down anywhere in this code (`i++`, `--count`)? A loop's counter is never one value. */
function stepped(scope: Node, isName: (target: Node) => boolean): boolean {
  return scope.descendantsOfType('update_expression').some((u) => {
    const target = u && parts(u)[0]
    return !!target && isName(target)
  })
}

/** The one value a field ever gets in its class: its starting value, or a single `this.canBus = canBus`. */
function setOnceInClass(use: Node, name: string, project: Project): Node | null {
  const [declared] = project.membersNamed(classAround(use), 'field', name)
  return declared ? onlyValueIn(declared, name) : null
}

/** A field's one value in the class that declares it: its start, or the one write to it (`ctreConfigs = new …()`). */
function onlyValueIn(declared: Node, name: string): Node | null {
  const body = enclosing(declared, BODIES)
  if (!body) return null
  const writes = body.descendantsOfType('assignment_expression').flatMap((a) => {
    const target = a && field(a, 'left')
    return target && (target.text === name || thisField(target) === name) ? [field(a, 'right')] : []
  })
  const values = [field(declared, 'value'), ...writes].filter((v) => v !== null)
  return values.length === 1 && !stepped(body, (target) => target.text === name || thisField(target) === name) ? values[0] : null
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
