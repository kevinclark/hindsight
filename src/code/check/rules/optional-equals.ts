/**
 * Is an Optional compared with a plain value by .equals? That is always false.
 *
 * Checks: `.equals(...)` between a call that returns an Optional (libraries.ts: `DriverStation.getAlliance()`) and a
 * class's constant or a literal (`Alliance.Blue`), either way round. A variable it can't see the type of is left
 * alone: `getAlliance().equals(lastAlliance)` compares two Optionals, which is right.
 * Why: Rebuilt 327a449 fixed `DriverStation.getAlliance().equals(Alliance.Blue)`, which is never true, so the blue
 * side's branch never ran. The same line is in 2026-Robot-Template, which new robots start from.
 */
import { field, nameOf, parts, quote, type Node } from '../java.ts'
import { OPTIONAL_CALLS } from '../libraries.ts'
import { codeRule } from '../rule.ts'

const LITERALS = ['true', 'false', 'string_literal', 'decimal_integer_literal', 'decimal_floating_point_literal']

export default codeRule({
  id: 'code/optional-equals',
  title: 'An Optional compared with a plain value',
  meaning: 'DriverStation.getAlliance() gives an Optional (the alliance, or nothing yet), not an Alliance. An Optional never equals an Alliance, so this comparison is always false and its branch never runs.',
  nextStep: 'Compare what is inside: DriverStation.getAlliance().orElse(Alliance.Blue) == Alliance.Blue, or getAlliance().equals(Optional.of(Alliance.Blue)).',
  incident: 'Rebuilt 327a449 fixed DriverStation.getAlliance().equals(Alliance.Blue): the blue branch never ran',
  forEach: 'method_invocation',

  check(call) {
    if (nameOf(call) !== 'equals') return
    const receiver = field(call, 'object')
    const [argument] = parts(call, 'arguments')
    if (!receiver || !argument) return
    const optional = [receiver, argument].find(isOptionalCall)
    const other = optional?.equals(receiver) ? argument : receiver
    if (!optional || !isPlainValue(other)) return
    return { message: `${quote(call)} is always false: ${quote(optional)} is an Optional and ${quote(other)} isn't` }
  },
})

/** A call in the Optional table: `DriverStation.getAlliance()`. */
const isOptionalCall = (node: Node) => node.type === 'method_invocation' && OPTIONAL_CALLS.has(`${field(node, 'object')?.text}.${nameOf(node)}`)

/** A literal, or an Alliance (`Alliance.Blue`, `DriverStation.Alliance.Red`): never an Optional. */
function isPlainValue(node: Node): boolean {
  if (LITERALS.includes(node.type)) return true
  return node.type === 'field_access' && /(^|\.)Alliance$/.test(field(node, 'object')?.text ?? '')
}
