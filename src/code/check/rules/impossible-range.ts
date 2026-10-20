/**
 * Does a condition ask for a value both above one number and below a smaller one? It can never be true.
 *
 * Checks: a chain of `&&` (parentheses allowed) holding two comparisons of the same thing (written the same way) with
 * numbers it can work out, one from below (`x >= 1`) and one from above (`x < 0`), with no value between them.
 * Either may be written the other way round (`0 > x`).
 * Why: 2026-Offseason-Robot 360095e (2026-10-15) wrote `getRadians() >= Math.PI / 2 && getRadians() < -(Math.PI / 2)`
 * while fixing a different range, so the branch that turns to 180° can never run.
 */
import { codeOf, field, operatorOf, parts, quote, type Node } from '../java.ts'
import type { Project } from '../project.ts'
import { codeRule, round } from '../rule.ts'
import { valueOf } from '../values.ts'

/** Each comparison, as "subject op number", and the same op with the sides swapped. */
const SWAPPED: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }

export default codeRule({
  id: 'code/impossible-range',
  title: 'A range nothing can be in',
  meaning: 'The condition asks for a value at least one number and below a smaller one at the same time. No value is both, so the condition is always false and its branch never runs.',
  nextStep: 'Work out the range you meant (an angle near ±π often needs two ranges joined with ||, or MathUtil.inputModulus first).',
  incident: '2026-Offseason-Robot 360095e: getRadians() >= Math.PI / 2 && getRadians() < -(Math.PI / 2), the 180° branch never runs',
  forEach: 'binary_expression',

  check(chain, project) {
    if (operatorOf(chain) !== '&&' || operatorOf(unwrapped(chain).parent) === '&&') return   // each chain once, whole
    const bounds = comparisonsIn(chain).flatMap((c) => boundOf(c, project) ?? [])
    const lowers = bounds.filter((b) => b.op.startsWith('>'))
    const uppers = bounds.filter((b) => b.op.startsWith('<'))
    const empty = lowers.flatMap((lower) => uppers.filter((upper) => upper.subject === lower.subject && nothingBetween(lower, upper)).map((upper) => ({ lower, upper })))
    if (empty.length === 0) return
    const { lower, upper } = empty[0]
    return {
      message: `${quote(chain)} is never true: nothing is ${lower.op} ${round(lower.value, 3)} and ${upper.op} ${round(upper.value, 3)}`,
      evidence: { 'lower bound': round(lower.value, 4), 'upper bound': round(upper.value, 4) },
    }
  },
})

type Bound = { subject: string; op: string; value: number }

/** No number is above (or at) `lower` and below (or at) `upper`. */
function nothingBetween(lower: Bound, upper: Bound): boolean {
  const touching = lower.value === upper.value && lower.op === '>=' && upper.op === '<='
  return lower.value > upper.value || (lower.value === upper.value && !touching)
}

/** Every comparison joined by `&&` in a chain, through parentheses. */
function comparisonsIn(node: Node): Node[] {
  const inner = node.type === 'parenthesized_expression' ? parts(node)[0] : node
  if (!inner) return []
  if (operatorOf(inner) === '&&') return [...comparisonsIn(field(inner, 'left') ?? inner), ...comparisonsIn(field(inner, 'right') ?? inner)]
  return SWAPPED[operatorOf(inner) ?? ''] ? [inner] : []
}

/** The node with any parentheses around it. */
function unwrapped(node: Node): Node {
  let at = node
  while (at.parent?.type === 'parenthesized_expression') at = at.parent
  return at
}

/** A comparison as `subject op number` (`x >= 1.571`), turned round if the number is on the left; null otherwise. */
function boundOf(comparison: Node | null, project: Project): Bound | null {
  const op = operatorOf(comparison)
  if (!comparison || !op || !SWAPPED[op]) return null
  const left = field(comparison, 'left')
  const right = field(comparison, 'right')
  const rightValue = valueOf(right, project)
  const leftValue = valueOf(left, project)
  if (left && rightValue && !leftValue) return { subject: codeOf(left), op, value: rightValue.number }
  if (right && leftValue && !rightValue) return { subject: codeOf(right), op: SWAPPED[op], value: leftValue.number }
  return null
}
