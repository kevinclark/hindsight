/**
 * Does a whole-number division lose its remainder on the way into a decimal?
 *
 * Checks: every calculation with a `/` of two whole numbers (int or long literals, or int constants) that doesn't come
 * out exact, when the answer goes into a decimal: a double or float variable, the return of a method declared double,
 * a cast to double, a Phoenix 6 config field, or arithmetic with a decimal number. A division it can't work out (a
 * method call, a variable) is listed as not judged, never as a finding.
 * Why: 2026-Offseason-Robot fixed this three times in ten days (dc7418c, dd1f33c, 3b31ea3), and `GEAR_RATIO = 50 / 12`
 * (4, not 4.17) stayed on the line above one of the fixes. Error Prone's NarrowCalculation finds it in the build too.
 */
import { field, fills, operatorOf, parts, quote, type Node } from '../java.ts'
import type { Project } from '../project.ts'
import { codeRule, pct, round } from '../rule.ts'
import { destinationType } from '../types.ts'
import { DECIMAL_TYPES, isArithmetic, valueOf } from '../values.ts'

export default codeRule({
  id: 'code/integer-division',
  title: 'Whole-number division where a decimal was meant',
  meaning: 'Java divides two whole numbers as whole numbers and drops the remainder: 50 / 12 is 4, not 4.17. The answer then goes into a decimal, so the code looks right but the number is off.',
  nextStep: 'Write one side as a decimal, for example 50.0 / 12 instead of 50 / 12, then check what used the old value.',
  incident: '2026-Offseason-Robot dd1f33c fixed KICKER_GEAR_RATIO = 30 / 12 and left GEAR_RATIO = 50 / 12 on the line above',
  forEach: 'binary_expression',

  check(calculation, project) {
    if (partOfLargerCalculation(calculation)) return        // each calculation once, from its outermost operator
    const divisions = divisionsIn(calculation)
    if (divisions.length === 0) return
    const intoDecimal = DECIMAL_TYPES.includes(destinationType(outermost(calculation)) ?? '')
    const lossy = divisions.filter((d) => dropsARemainder(d, project) && (intoDecimal || meetsADecimal(d, project)))
    const unknown = intoDecimal && divisions.some((d) => mightBeWhole(d, project))
    if (lossy.length === 0 && unknown) return project.couldNotJudge(`a value in ${quote(calculation)} it can't work out`)
    if (lossy.length === 0) return

    // The whole calculation, as Java does it and as it was meant; just the first division when the rest can't be worked out.
    const shown = valueOf(calculation, project) ? calculation : lossy[0]
    const java = valueOf(shown, project)
    const meant = valueOf(shown, project, { exact: true })
    if (!java || !meant || meant.number === 0) return project.couldNotJudge(`couldn't work out ${quote(shown)}`)
    const error = (java.number - meant.number) / meant.number
    return {
      message: `${quote(shown)} is ${round(java.number, 4)} in Java, not ${round(meant.number, 4)} (${pct(error)})`,
      evidence: { 'Java computes': round(java.number, 4), 'meant': round(meant.number, 4), 'error': pct(error) },
    }
  },
})

/** Is this operator inside a bigger calculation (`34 / 28` in `27 * (34 / 28)`)? Then the bigger one is checked. */
const partOfLargerCalculation = (node: Node) => isArithmetic(outermost(node).parent)

/** The calculation with any parentheses or minus sign around it: what its answer goes into is above that. */
function outermost(node: Node): Node {
  let at = node
  while (at.parent?.type === 'parenthesized_expression' || at.parent?.type === 'unary_expression') at = at.parent
  return at
}

/** Every `/` in a calculation, through parentheses and other arithmetic but not into method calls or casts. */
function divisionsIn(node: Node | null): Node[] {
  if (node?.type === 'parenthesized_expression') return divisionsIn(parts(node)[0] ?? null)
  if (node?.type === 'unary_expression') return divisionsIn(field(node, 'operand'))
  if (!node || !isArithmetic(node)) return []
  const inside = [...divisionsIn(field(node, 'left')), ...divisionsIn(field(node, 'right'))]
  return operatorOf(node) === '/' ? [node, ...inside] : inside
}

/** Two whole numbers that don't divide exactly. */
function dropsARemainder(division: Node, project: Project): boolean {
  const left = valueOf(field(division, 'left'), project)
  const right = valueOf(field(division, 'right'), project)
  if (!left?.whole || !right?.whole) return false
  return left.number % right.number !== 0
}

/** A division it can't work out, with no decimal side it knows of: it might be two whole numbers. */
function mightBeWhole(division: Node, project: Project): boolean {
  const sides = [valueOf(field(division, 'left'), project), valueOf(field(division, 'right'), project)]
  return sides.includes(null) && !sides.some((side) => side?.whole === false)
}

/** Does the division's answer meet a decimal number on the way up (`(7368 / 60) / 0.5`)? Java makes it a decimal there. */
function meetsADecimal(division: Node, project: Project): boolean {
  let at = outermost(division)
  for (let parent = at.parent; parent && isArithmetic(parent); parent = at.parent) {
    const other = fills(at, 'left') ? field(parent, 'right') : field(parent, 'left')
    if (valueOf(other, project)?.whole === false) return true
    at = outermost(parent)
  }
  return false
}
