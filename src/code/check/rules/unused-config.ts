/**
 * Is a device's configuration passed in and never used?
 *
 * Checks: a constructor or method parameter whose type ends in `Configuration` (`TalonFXConfiguration`,
 * `CANdleConfiguration`, …) that nothing in its body reads. Only that type: unused parameters of other types are
 * mostly harmless (a thread name kept for later): 10 of the 13 at the heads of 10 FRC repos (2026-10-20). A method with
 * no body (in an interface, or abstract) is left alone.
 * Why: Rebuilt d90f86a fixed a HoodIO that was given its TalonFXConfiguration and never applied it, so the hood ran
 * Phoenix's defaults.
 */
import { field, fills, nameOf, type Node } from '../java.ts'
import { codeRule } from '../rule.ts'
import { localNamed } from '../types.ts'

const TAKES_A_CONFIG = /Configuration$/

export default codeRule({
  id: 'code/unused-config',
  title: 'A configuration passed in and never used',
  meaning: 'The code builds a configuration and passes it here, but nothing here applies it, so the device keeps whatever it ran before (often Phoenix\'s defaults: no current limits you chose, no gear ratio, no gains).',
  nextStep: 'Apply it to the device (motor.getConfigurator().apply(config)), or stop passing it if the device really needs none.',
  incident: 'Rebuilt d90f86a: HoodIO was given its TalonFXConfiguration and never applied it',
  forEach: 'formal_parameter',

  check(parameter) {
    const name = nameOf(parameter)
    const type = field(parameter, 'type')?.text ?? ''
    const declaration = parameter.parent?.parent
    const body = declaration && field(declaration, 'body')
    if (!name || !TAKES_A_CONFIG.test(type) || !body) return
    if (readsOf(name, parameter, body).length > 0) return
    return { message: `${name} (${type}) is passed to ${nameOf(declaration)}(…) and never used` }
  },
})

/** Every mention of the parameter in the body: its name where it means this parameter, not `this.name` or a local. */
function readsOf(name: string, parameter: Node, body: Node): Node[] {
  const isParameter = (id: Node) => id.text === name && !fills(id, 'field') && localNamed(id, name)?.equals(parameter) === true
  return body.descendantsOfType('identifier').filter((id): id is Node => !!id && isParameter(id))
}
