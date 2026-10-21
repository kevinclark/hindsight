/**
 * Does a step of a sequence never end, so the steps after it never run? Or does a command that ends at once wait?
 *
 * Checks:
 * - every sequence (`Commands.sequence(a, b)`, `new SequentialCommandGroup(a, b)`, `addCommands(a, b)` or `super(a, b)`
 *   in a class that extends SequentialCommandGroup, and `a.andThen(b)`): a step before the last that never ends on
 *   its own (libraries.ts: `this.run(..)`, `new RunCommand(..)`, `.repeatedly()`, and those through decorators that
 *   end when they do). A sequence moves to its next step only when a step ends.
 * - anywhere: a command that ends the first time it runs (`runOnce`, `new InstantCommand(..)`) given `.until(..)` or
 *   `.withTimeout(..)`. It has already ended, so they never wait. `.until(() -> true)` waits for nothing on purpose.
 * Only commands written out where they are used: a step that calls a method of the project returning `this.run(..)`
 * isn't followed. A `run` is WPILib's only on a subsystem (`this.run`, `shooter.run`) whose class has no `run` of its
 * own: Charged-Up declares a `run(Command...)` that builds a parallel group.
 * Why: Rapid-React fde835e and 74087e6 fixed a RunCommand that stopped a shooting sequence; dd9be00 turned three
 * InstantCommand(..).withInterrupt(..) into RunCommands so the climber waited. 2026-Offseason-Robot's intake zeroing
 * (SlapdownSubsystem runCurrentZeroing) starts with this.run(..), so it never resets the encoder.
 */
import { field, nameOf, parts, quote, superclassName, classAround, typeNamed, type Node } from '../java.ts'
import { COMMAND_FACTORIES, ENDLESS_CLASSES, ENDLESS_FACTORIES, INSTANT_CLASSES, INSTANT_FACTORIES, SAME_END_DECORATORS, WAITING_DECORATORS } from '../libraries.ts'
import { baseType, type Project } from '../project.ts'
import { codeRule, plural, type CodeProblem } from '../rule.ts'
import { isSubsystem, typeOf } from '../types.ts'

const SEQUENCE_GROUP = 'SequentialCommandGroup'

export default codeRule({
  id: 'code/never-ending-step',
  title: 'A command step that never ends, or never waits',
  meaning: 'A sequence runs one step at a time and moves on only when a step ends. A step built with run(...) or RunCommand never ends on its own, so the steps after it never run. A command built with runOnce(...) or InstantCommand ends the first time it runs, so an until(...) or withTimeout(...) on it waits for nothing.',
  nextStep: 'Give the endless step an end (.until(...), .withTimeout(...)) or make it the last step; for a step that must wait, build it with run(...) and .until(...) instead of runOnce.',
  incident: '2026-Offseason-Robot SlapdownSubsystem: the intake zeroing sequence starts with this.run(...), so it never resets the encoder',

  check(project) {
    const sequences = [...project.nodes('method_invocation'), ...project.nodes('object_creation_expression'), ...project.nodes('explicit_constructor_invocation')]
    const endless = sequences.flatMap((s) => stepsOf(s, project)).flatMap(({ step, after }) => endlessStep(step, after, project))
    const waits = project.nodes('method_invocation').flatMap((call) => waitOnInstant(call, project))
    return [...endless, ...waits]
  },
})

/** The steps of a sequence, each with how many come after it; none when the node isn't a sequence. */
function stepsOf(node: Node, project: Project): { step: Node; after: number }[] {
  const steps = sequenceSteps(node, project)
  return steps.map((step, i) => ({ step, after: steps.length - 1 - i }))
}

/** `Commands.sequence(a, b)`, `new SequentialCommandGroup(a, b)`, `addCommands`/`super` in one, `a.andThen(b)`. */
function sequenceSteps(node: Node, project: Project): Node[] {
  const passed = parts(node, 'arguments')
  if (node.type === 'object_creation_expression') return baseType(typeNamed(node)) === SEQUENCE_GROUP ? passed : []
  const inGroup = isSequenceGroup(classAround(node), project)
  if (node.type === 'explicit_constructor_invocation') return node.text.startsWith('super') && inGroup ? passed : []
  const receiver = field(node, 'object')
  const method = nameOf(node)
  if (method === 'sequence' && receiver?.text === COMMAND_FACTORIES) return passed
  if (method === 'addCommands' && (!receiver || receiver.type === 'this') && inGroup) return passed
  return method === 'andThen' && receiver ? [receiver, ...passed] : []
}

/** Does this class (or a project class above it) extend SequentialCommandGroup? */
const isSequenceGroup = (cls: Node | null, project: Project) => superclassName(project.lineage(cls).at(-1) ?? null) === SEQUENCE_GROUP

/** A finding when a step before the last never ends. */
function endlessStep(step: Node, after: number, project: Project): CodeProblem[] {
  if (after === 0 || !neverEnds(step, project)) return []
  return [{ message: `${quote(step)} never ends on its own, so the ${plural(after, 'step')} after it never run${after === 1 ? 's' : ''}`, at: step }]
}

/** Is this command one that never ends on its own: an endless factory or class, `.repeatedly()`, or one wrapping it? */
function neverEnds(command: Node, project: Project): boolean {
  if (command.type === 'parenthesized_expression') return neverEnds(parts(command)[0] ?? command, project)
  if (command.type === 'object_creation_expression') return ENDLESS_CLASSES.includes(baseType(typeNamed(command)) ?? '')
  if (command.type !== 'method_invocation') return false
  const method = nameOf(command) ?? ''
  const receiver = field(command, 'object')
  if (method === 'repeatedly') return true
  if (SAME_END_DECORATORS.includes(method) && receiver) return neverEnds(receiver, project)
  return ENDLESS_FACTORIES.includes(method) && isWpilibFactory(command, project)
}

/** A finding when a command that ends at once is given an until(...) or withTimeout(...) that would make it wait. */
function waitOnInstant(call: Node, project: Project): CodeProblem[] {
  const method = nameOf(call) ?? ''
  const receiver = field(call, 'object')
  const [condition] = parts(call, 'arguments')
  if (!WAITING_DECORATORS.includes(method) || !receiver || !endsAtOnce(receiver, project)) return []
  if (condition?.type === 'lambda_expression' && field(condition, 'body')?.type === 'true') return []   // waits for nothing on purpose
  return [{ message: `${quote(receiver)} ends the first time it runs, so .${method}(…) never waits`, at: call }]
}

/** `runOnce(..)`, `Commands.print(..)`, `new InstantCommand(..)`: a command that ends the first time it runs. */
function endsAtOnce(command: Node, project: Project): boolean {
  if (command.type === 'object_creation_expression') return INSTANT_CLASSES.includes(baseType(typeNamed(command)) ?? '')
  return command.type === 'method_invocation' && INSTANT_FACTORIES.includes(nameOf(command) ?? '') && isWpilibFactory(command, project)
}

/**
 * Is this `run(..)`/`runOnce(..)` WPILib's: `Commands.run`, or a subsystem's (`this.run`, a bare `run` inside one,
 * `shooter.run`) when the subsystem's class doesn't declare a method of that name itself?
 */
function isWpilibFactory(call: Node, project: Project): boolean {
  const receiver = field(call, 'object')
  if (receiver?.text === COMMAND_FACTORIES) return true
  const owner = receiver ? typeOf(receiver, project) : nameOf(classAround(call) ?? call)
  const cls = project.classNamed(owner)
  return isSubsystem(owner, project) && project.membersNamed(cls, 'method', nameOf(call) ?? '').length === 0
}
