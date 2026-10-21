/**
 * Types read from the code, without a compiler: where a name is declared, and what type a value is going into. Only
 * what the code says outright (a declaration, a method's return type, a cast); anything else is null, "don't know".
 */
import { BODIES, classAround, enclosing, field, fills, nameOf, parts, typeNamed, type Node } from './java.ts'
import { COMMAND_DECORATORS, COMMAND_FACTORIES, PHOENIX_DECIMAL_FIELDS, SUBSYSTEM_COMMANDS, SUBSYSTEM_TYPES } from './libraries.ts'
import { baseType, type Project } from './project.ts'

/** Where a value can be declared inside a method: a local, a parameter, a for-loop or catch variable, a lambda's parameter. */
const LOCAL_SCOPES = ['block', 'method_declaration', 'constructor_declaration', 'lambda_expression', 'for_statement', 'enhanced_for_statement', 'catch_clause', 'switch_block_statement_group']
const DECLARES = ['variable_declarator', 'formal_parameter', 'catch_formal_parameter', 'inferred_parameters', 'lambda_expression', 'enhanced_for_statement']

/** The block (or method, loop, lambda) a local variable or parameter belongs to: where its name can be used. */
export const scopeOf = (declared: Node) => enclosing(declared, LOCAL_SCOPES)

/** Where a declared name can be used: a field's whole class (and the classes inside it), else a local's scope. */
export const visibleIn = (declared: Node) => (declared.parent?.type === 'field_declaration' ? enclosing(declared, BODIES) : scopeOf(declared))

/**
 * The local variable or parameter `name` seen from `node`: its declarator (or parameter), or null when the name isn't
 * declared in the method (then it is a field, or from another class).
 */
export function localNamed(node: Node, name: string): Node | null {
  for (let scope = enclosing(node, LOCAL_SCOPES); scope; scope = enclosing(scope, LOCAL_SCOPES)) {
    const declared = scope.descendantsOfType(DECLARES).flatMap((d) => (d ? declaredNames(d) : []))
    const found = declared.find((d) => nameOf(d) === name && d.startIndex < node.startIndex && scopeOf(d)?.equals(scope))
    if (found) return found
  }
  return null
}

/** The declared type of a local, parameter or field declarator, as written ("double", "Matrix<N3, N1>"), or null. */
export function declaredType(declared: Node): string | null {
  const declaration = declared.type === 'variable_declarator' ? declared.parent : declared
  return declaration && typeNamed(declaration)
}

/**
 * The type a value is going into, when the code says it: the type of the variable it initialises, the return type of
 * the method it is returned from, the type it is cast to, or a Phoenix 6 config field it is assigned to (all decimals).
 */
export function destinationType(value: Node): string | null {
  const parent = value.parent
  if (!parent) return null
  if (parent.type === 'variable_declarator' && fills(value, 'value')) return declaredType(parent)
  if (parent.type === 'cast_expression') return typeNamed(parent)
  if (parent.type === 'return_statement') {
    const method = enclosing(parent, ['method_declaration', 'lambda_expression'])
    return method?.type === 'method_declaration' ? typeNamed(method) : null
  }
  if (parent.type === 'assignment_expression' && fills(value, 'right')) {
    const target = field(parent, 'left')
    const name = target?.type === 'field_access' ? field(target, 'field')?.text : null
    return name && PHOENIX_DECIMAL_FIELDS.has(name) ? 'double' : null
  }
  return null
}

/**
 * The class of a value when the code says it, without type arguments ("Matrix", "Command"), or null: a variable,
 * parameter or field with a declared type, `new X(…)`, a cast, `this`, a `Commands.` factory, a decorator on a
 * Command, a subsystem's command method (`runOnce`), or a method of a project class with a declared return type.
 */
export function typeOf(node: Node | null, project: Project): string | null {
  if (!node) return null
  switch (node.type) {
    case 'parenthesized_expression':
      return typeOf(parts(node)[0] ?? null, project)
    case 'object_creation_expression':
    case 'cast_expression':
      return baseType(typeNamed(node))
    case 'this':
      return nameOf(classAround(node) ?? node)
    case 'identifier':
      return variableType(node, node.text, project)
    case 'field_access':
      return field(node, 'object')?.type === 'this' ? variableType(node, field(node, 'field')?.text ?? '', project) : null
    case 'method_invocation':
      return returnType(node, project)
  }
  return null
}

/** Is this a project class that is a subsystem (extends SubsystemBase or implements Subsystem, here or above)? */
export function isSubsystem(type: string | null, project: Project): boolean {
  const supers = (c: Node) => [field(c, 'superclass'), field(c, 'interfaces')].flatMap((s) => s?.descendantsOfType('type_identifier') ?? [])
  return project.lineage(project.classNamed(type)).some((c) => supers(c).some((t) => SUBSYSTEM_TYPES.includes(t?.text ?? '')))
}

/**
 * Where a name used at `node` is declared: a local or parameter, else a field of this class or the project classes
 * above it (its declarator), or null when it can't tell.
 */
export function declarationOf(node: Node, name: string, project: Project): Node | null {
  return localNamed(node, name) ?? sameAnswer(project.membersNamed(classAround(node), 'field', name))
}

/** A local, parameter or field (of this class or the project classes above it) by name: its declared type. */
function variableType(node: Node, name: string, project: Project): string | null {
  const declared = declarationOf(node, name, project)
  if (!declared) return null
  const type = baseType(declaredType(declared))
  return type === 'var' ? typeOf(field(declared, 'value'), project) : type
}

/** What a method call returns, when this project or the WPILib tables (libraries.ts) say. */
function returnType(call: Node, project: Project): string | null {
  const receiver = field(call, 'object')
  const method = nameOf(call) ?? ''
  if (receiver?.text === COMMAND_FACTORIES) return 'Command'
  const owner = receiver ? typeOf(receiver, project) : nameOf(classAround(call) ?? call)
  if (owner === 'Command' && COMMAND_DECORATORS.includes(method)) return 'Command'
  // The project's own method of that name comes first: a subsystem's `private void run()` isn't Subsystem.run.
  const declarations = project.membersNamed(project.classNamed(owner), 'method', method)
  if (declarations.length) return baseType(typeNamed(sameAnswer(declarations, typeNamed) ?? call))
  return SUBSYSTEM_COMMANDS.includes(method) && isSubsystem(owner, project) ? 'Command' : null
}

/** The first of several declarations when they all agree (on `key`, by default their type); null when they don't. */
function sameAnswer(declarations: Node[], key = (d: Node) => declaredType(d)): Node | null {
  const [first] = declarations
  return first && declarations.every((d) => key(d) === key(first)) ? first : null
}


/** What a declaration adds to its scope: itself, or a lambda's bare parameters (`x -> …`, `(x, y) -> …`). */
function declaredNames(declaration: Node): Node[] {
  if (declaration.type === 'inferred_parameters') return parts(declaration)
  if (declaration.type !== 'lambda_expression') return [declaration]
  const parameter = field(declaration, 'parameters')
  return parameter?.type === 'identifier' ? [parameter] : []
}
