/**
 * Numbers worked out from the code without running it: literals, named constants, `Math.PI`, and arithmetic on them,
 * by Java's rules. `valueOf(node, project)` is what Java computes (`50 / 12` is 4); `valueOf(node, project, { exact:
 * true })` is what the code meant, every division done in full (4.1667). Anything it can't work out (a method call, a
 * variable that can change, a name with two different values) is null.
 */
import { codeOf, field, modifiersOf, operatorOf, ownerAround, parts, typeNamed, type Node } from './java.ts'
import type { Project } from './project.ts'
import { declaredType, localNamed } from './types.ts'

export interface Value {
  number: number
  /** Java holds it as a whole number (an int or a long), so dividing two of them drops the remainder. */
  whole: boolean
}

const BUILT_IN: Record<string, Value> = {
  'Math.PI': { number: Math.PI, whole: false },
  'Math.E': { number: Math.E, whole: false },
}
export const WHOLE_TYPES = ['int', 'long', 'short', 'byte']
export const DECIMAL_TYPES = ['double', 'float']
const ARITHMETIC = ['+', '-', '*', '/', '%']

/** `a + b`, `a / b`, …: arithmetic, as opposed to `a && b` or `a < b`. */
export const isArithmetic = (node: Node | null | undefined) => node?.type === 'binary_expression' && ARITHMETIC.includes(operatorOf(node) ?? '')
/** Java's int holds up to this; past it Java wraps round, which isn't worked out here (no FRC case so far). */
const LARGEST_INT = 2 ** 31 - 1
/** Constants defined from other constants, this many deep, are as far as it looks (a cycle stops here too). */
const MOST_HOPS = 8

export function valueOf(node: Node | null, project: Project, options = { exact: false }, hops = 0): Value | null {
  if (!node || hops > MOST_HOPS) return null
  const inner = (n: Node | null) => valueOf(n, project, options, hops + 1)
  switch (node.type) {
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'octal_integer_literal':
    case 'binary_integer_literal':
      return { number: Number(node.text.replace(/[_lL]/g, '').replace(/^0(?=[0-7])/, '0o')), whole: true }
    case 'decimal_floating_point_literal':
      return { number: parseFloat(node.text.replace(/_/g, '')), whole: false }
    case 'parenthesized_expression':
      return inner(parts(node)[0] ?? null)
    case 'unary_expression': {
      const operand = inner(field(node, 'operand'))
      if (!operand) return null
      if (operatorOf(node) === '-') return { ...operand, number: -operand.number }
      return operatorOf(node) === '+' ? operand : null
    }
    case 'cast_expression': {
      const operand = inner(field(node, 'value'))
      const type = typeNamed(node) ?? ''
      if (!operand) return null
      if (WHOLE_TYPES.includes(type)) return { number: Math.trunc(operand.number), whole: true }
      return DECIMAL_TYPES.includes(type) ? { number: operand.number, whole: false } : null
    }
    case 'binary_expression':
      return arithmetic(operatorOf(node), inner(field(node, 'left')), inner(field(node, 'right')), options.exact)
    case 'identifier':
    case 'field_access':
      return BUILT_IN[codeOf(node)] ?? constantNamed(node, project, (n) => inner(n))
  }
  return null
}

/** `a op b` by Java's rules: two whole numbers make a whole number, and dividing them drops the remainder. */
function arithmetic(op: string | null, a: Value | null, b: Value | null, exact: boolean): Value | null {
  const result = exactly(op, a, b, exact)
  return result?.whole && Math.abs(result.number) > LARGEST_INT ? null : result
}

function exactly(op: string | null, a: Value | null, b: Value | null, exact: boolean): Value | null {
  if (!a || !b) return null
  const whole = a.whole && b.whole
  if (op === '+') return { number: a.number + b.number, whole }
  if (op === '-') return { number: a.number - b.number, whole }
  if (op === '*') return { number: a.number * b.number, whole }
  if (op === '/' && b.number !== 0) return { number: whole && !exact ? Math.trunc(a.number / b.number) : a.number / b.number, whole }
  if (op === '%' && b.number !== 0) return { number: a.number % b.number, whole }
  return null
}

/**
 * The `final` field a name means (`GEAR_RATIO`, `IndexerIO.GEAR_RATIO`), when every field it could mean has the same
 * value. Whole or not comes from its declared type: `static final double TICKS = 2048` is a decimal. An interface's
 * fields are final without saying so.
 */
function constantNamed(node: Node, project: Project, valueOfInitialiser: (n: Node | null) => Value | null): Value | null {
  const name = node.type === 'field_access' ? field(node, 'field')?.text : node.text
  if (!name || (node.type === 'identifier' && localNamed(node, name))) return null
  const values = fieldsMeant(node, name, project).map((declarator) => {
    const declaration = declarator.parent
    if (!declaration || !isFinal(declaration)) return null
    const value = valueOfInitialiser(field(declarator, 'value'))
    return value && { number: value.number, whole: WHOLE_TYPES.includes(declaredType(declarator) ?? '') }
  })
  const [first] = values
  if (!first || values.some((v) => v?.number !== first.number || v.whole !== first.whole)) return null
  return first
}

/** Is this field final: said so, or in an interface (where every field is)? */
function isFinal(declaration: Node): boolean {
  return declaration.type === 'constant_declaration' || modifiersOf(declaration).includes('final')
}

/**
 * The fields a name can mean: `Owner.NAME` is Owner's (`Constants.Shooter.NAME`: the Shooter inside Constants; every
 * Owner, when two classes share the name); a bare NAME is the enclosing classes' (with the project classes above
 * them and the interfaces they implement), else a class the file imports statically (`import static
 * frc.robot.Constants.*`). A name from a library class (TimedRobot's kDefaultPeriod) means none: never a same-named
 * constant elsewhere in the project. constantNamed then needs every field meant to have one value.
 */
function fieldsMeant(node: Node, name: string, project: Project): Node[] {
  const fieldsOf = (owner: Node) => project.membersNamed(owner, 'field', name)
  if (node.type === 'field_access') {
    const owner = field(node, 'object')?.text.replace(/\s+/g, '') ?? null
    return project.ownersNamed(owner).flatMap(fieldsOf)
  }
  for (let owner = ownerAround(node); owner; owner = ownerAround(owner)) {
    const own = fieldsOf(owner)
    if (own.length) return own
  }
  const imported = staticImports(project.fileOf(node).tree.rootNode).flatMap((path) => project.ownersNamed(path))
  return imported.flatMap(fieldsOf)
}

/** The classes a file imports static members from: `import static frc.robot.Constants.*` is "frc.robot.Constants". */
function staticImports(root: Node): string[] {
  return parts(root).filter((n) => n.type === 'import_declaration').flatMap((n) => {
    const path = /^import\s+static\s+([\w.]+?)(\.\*)?\s*;/.exec(codeOf(n))
    if (!path) return []
    return [path[2] ? path[1] : path[1].replace(/\.\w+$/, '')]
  })
}
