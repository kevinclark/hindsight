/**
 * Does a condition ask for a value both above one number and below a smaller one? It can never be true.
 *
 * Checks: `a && b` where both sides compare the same thing (written the same way) with numbers it can work out, one
 * from below (`x >= 1`) and one from above (`x < 0`), with no value between them. Either side may be written the
 * other way round (`0 > x`).
 * Why: 2026-Offseason-Robot 360095e (2026-10-15) wrote `getRadians() >= Math.PI / 2 && getRadians() < -(Math.PI / 2)`
 * while fixing a different range, so the branch that turns to 180° can never run.
 */
import { codeOf, field, operatorOf, quote, type Node } from '../java.ts'
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

  check(both, project) {
    if (operatorOf(both) !== '&&') return
    const left = boundOf(field(both, 'left'), project)
    const right = boundOf(field(both, 'right'), project)
    if (!left || !right || left.subject !== right.subject) return
    const lower = [left, right].find((b) => b.op.startsWith('>'))
    const upper = [left, right].find((b) => b.op.startsWith('<'))
    if (!lower || !upper) return
    const touching = lower.value === upper.value && lower.op === '>=' && upper.op === '<='
    if (lower.value < upper.value || touching) return
    return {
      message: `${quote(both)} is never true: nothing is ${lower.op} ${round(lower.value, 3)} and ${upper.op} ${round(upper.value, 3)}`,
      evidence: { 'lower bound': round(lower.value, 4), 'upper bound': round(upper.value, 4) },
    }
  },
})

/** A comparison as `subject op number` (`x >= 1.571`), turned round if the number is on the left; null otherwise. */
function boundOf(comparison: Node | null, project: Project): { subject: string; op: string; value: number } | null {
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
