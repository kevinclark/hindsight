/**
 * Is a value built and thrown away, when building it is all the call does?
 *
 * Checks: a statement that is only a call whose answer nobody uses, when the call has no other effect:
 * - a method of a WPILib class whose objects never change (libraries.ts: `Matrix.times`, `Pose2d.plus`, …), on a
 *   value whose type the code declares. `deviations.times(2)` makes a new matrix; `deviations` stays as it was;
 * - a call that returns a Command: a `Commands.` factory, a decorator (`.withTimeout`), a subsystem's `runOnce`, or a
 *   method the project declares as returning Command. A Command does nothing until it is scheduled or bound.
 * A call on a value whose type it can't see is left alone.
 * Why: 2026-Offseason-Robot Camera.java threw away three `deviations.times(...)` (since 2026-08-30), so the vision
 * trust scaling did nothing. Reefscape afc174e and Rebuilt ae671de fixed Commands built inside a lambda or loop and
 * never run.
 */
import { field, nameOf, parts, quote } from '../java.ts'
import { UNCHANGING } from '../libraries.ts'
import { codeRule } from '../rule.ts'
import { typeOf } from '../types.ts'

export default codeRule({
  id: 'code/discarded-result',
  title: 'A result built and thrown away',
  meaning: 'The call only builds a new value and gives it back, and nothing uses it: the line does nothing. WPILib matrices, poses and rotations never change (times, plus and rotateBy make new ones), and a Command does nothing until it is scheduled.',
  nextStep: 'Use the answer: deviations = deviations.times(2), return the Command, or bind it to a trigger.',
  incident: '2026-Offseason-Robot Camera.java: three deviations.times(...) results thrown away, so vision trust scaling did nothing',
  forEach: 'expression_statement',

  check(statement, project) {
    const [call] = parts(statement)
    if (call?.type !== 'method_invocation') return
    const method = nameOf(call) ?? ''
    const receiver = field(call, 'object')
    const owner = typeOf(receiver, project)
    if (receiver && owner && UNCHANGING[owner]?.includes(method)) {
      return { message: `${quote(receiver)}.${method}(…) makes a new ${owner} and nothing uses it: ${quote(receiver)} is unchanged` }
    }
    if (typeOf(call, project) === 'Command') return { message: `${quote(call)} builds a Command that is never run` }
  },
})
