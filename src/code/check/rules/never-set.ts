/**
 * Is a variable read in a condition, but never changed after its starting value?
 *
 * Checks: a variable read in a condition (`() -> !hoodZeroed`, `distance < minDistance`) that is never assigned
 * after its starting value, when the starting value says it was meant to change:
 * - a private, non-final field that starts as a literal (`false`, `0`, `null`);
 * - a local that starts as a stand-in to be beaten (`Double.MAX_VALUE`), read in a loop or lambda it is declared
 *   outside of.
 * A field or local that starts as a computed value (`int n = list.size()`) is a value taken once, not a flag, and
 * isn't checked: 45 of those at the heads of 19 FRC repos were all correct code (2026-10-20). Left out too: fields
 * that aren't private (another file, or code AdvantageKit generates, can write them), fields with an annotation, and
 * UPPER_SNAKE names (constants on purpose, like DEBUG = false). It doesn't tell a field from a local of the same name
 * in another method: a write to that local counts as a write, so it stays quiet (never a false finding).
 * Why: 2026-Offseason-Robot's `hoodZeroed` starts false and nothing sets it, so the hood re-zeroes on every enable.
 * 2026-Offseason-Robot afa0259 fixed a `minDistance` never updated in a closest-pose loop (it returned the last pose).
 */
import { codeOf, enclosing, quote, field, fills, isInside, lineOf, modifiersOf, nameOf, operatorOf, type Node } from '../java.ts'
import { codeRule } from '../rule.ts'
import { scopeOf } from '../types.ts'

const CONDITION_OPERATORS = ['!', '&&', '||', '<', '<=', '>', '>=', '==', '!=']
const HAS_A_CONDITION = ['if_statement', 'while_statement', 'do_statement', 'for_statement', 'ternary_expression']
const REPEATS = ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'lambda_expression']
const LITERALS = ['true', 'false', 'null_literal', 'decimal_integer_literal', 'decimal_floating_point_literal']
/** Starting values that only make sense if something replaces them: the first distance is always smaller. */
const STAND_INS = /^-?(Double|Float|Integer|Long)\.(MAX_VALUE|MIN_VALUE|POSITIVE_INFINITY|NEGATIVE_INFINITY)$/

export default codeRule({
  id: 'code/never-set',
  title: 'Read as if it changes, but never changes',
  meaning: 'The code checks this variable as if something sets it, but nothing in the code ever does: it keeps its starting value, so the condition always comes out the same way.',
  nextStep: 'Set it where the thing it stands for happens (hoodZeroed = true when zeroing finishes), or make it final if it really never changes.',
  incident: '2026-Offseason-Robot: hoodZeroed starts false and is never set, so the hood re-zeroes on every enable',
  forEach: 'variable_declarator',

  check(variable, project) {
    const declaration = variable.parent
    const name = nameOf(variable)
    const start = field(variable, 'value')
    if (!declaration || !name || !start || !canBeChecked(declaration, name, start)) return
    const isField = declaration.type === 'field_declaration'
    const scope = isField ? enclosing(declaration, ['class_body']) : scopeOf(declaration)
    if (!scope) return
    const uses = usesOf(name, scope).filter((u) => !fills(u, 'name'))
    if (uses.some(isWrite)) return
    const reads = uses.filter(isReadInCondition).filter((u) => isField || repeatsWithout(u, declaration))
    if (reads.length === 0) return
    const read = reads[0]
    return {
      message: `${name} starts as ${quote(start)} and nothing changes it, but ${quote(read.parent ?? read)} on line ${lineOf(read)} reads it`,
      evidence: { 'starting value': quote(start), 'read in conditions on lines': reads.map(lineOf).join(', ') },
    }
  },
})

/** A private non-final field starting as a literal, or a non-final local starting as a stand-in; never UPPER_SNAKE. */
function canBeChecked(declaration: Node, name: string, start: Node): boolean {
  const modifiers = modifiersOf(declaration)
  if (modifiers.includes('final') || /^[A-Z][A-Z0-9_]*$/.test(name)) return false
  if (declaration.type === 'local_variable_declaration') return STAND_INS.test(codeOf(start))
  const literal = LITERALS.includes(start.type)
  return declaration.type === 'field_declaration' && literal && modifiers.includes('private') && !modifiers.includes('@')
}

/** Every mention of the variable in its scope: `name`, or `this.name`. Method names and other objects' fields don't count. */
function usesOf(name: string, scope: Node): Node[] {
  return scope.descendantsOfType('identifier').flatMap((id) => {
    const parent = id?.parent
    if (!id || id.text !== name || !parent) return []
    if (parent.type === 'method_invocation' && fills(id, 'name')) return []
    if (parent.type === 'field_access' && fills(id, 'field')) return field(parent, 'object')?.type === 'this' ? [parent] : []
    return [id]
  })
}

/** `x = …`, `x += …`, `x++`. */
function isWrite(use: Node): boolean {
  const parent = use.parent
  if (parent?.type === 'update_expression') return true
  return parent?.type === 'assignment_expression' && fills(use, 'left')
}

/** Read by `!`, `&&`, a comparison, or as the condition of an `if`, a loop or a `? :`. */
function isReadInCondition(use: Node): boolean {
  const parent = use.parent
  if (!parent) return false
  if (CONDITION_OPERATORS.includes(operatorOf(parent) ?? '')) return true
  const condition = parent.type === 'parenthesized_expression' ? parent : use
  return HAS_A_CONDITION.includes(condition.parent?.type ?? '') && fills(condition, 'condition')
}

/** Is the read inside a loop or lambda that the declaration is outside of (so it runs again and again)? */
function repeatsWithout(read: Node, declaration: Node): boolean {
  for (let at = enclosing(read, REPEATS); at; at = enclosing(at, REPEATS)) if (!isInside(declaration, at)) return true
  return false
}
