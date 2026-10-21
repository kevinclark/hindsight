/**
 * All the Java files of one commit, parsed, with an index of what they declare by name: fields, methods and classes.
 * The rules ask it where a name is declared (`fieldsNamed('GEAR_RATIO')`) and which file a node is in (`fileOf`).
 */
import { enclosing, nameOf, ownerAround, parseJava, parts, superclassName, type JavaFile, type Node } from './java.ts'

/** How many superclasses up `lineage` looks (and where a cycle stops). */
const MOST_ANCESTORS = 8
/**
 * What the index finds by name, and the declarations it reads each from. An interface's fields are
 * `constant_declaration`s (every one is static and final), and an interface can own fields as a class does.
 */
const DECLARED = {
  field: ['field_declaration', 'constant_declaration'],
  method: ['method_declaration'],
  class: ['class_declaration', 'interface_declaration'],
}
/** Where a class's or interface's members are written (an anonymous class's body is a class_body inside a `new`). */
const BODIES = ['class_body', 'interface_body']

/** A type without its type arguments or package: "Matrix<N3, N1>" is "Matrix", "frc.robot.Robot" is "Robot". */
export const baseType = (type: string | null | undefined) => type?.replace(/<.*$/s, '').split('.').pop()?.trim() || null

export class Project {
  readonly files: JavaFile[]
  private byTree = new Map<unknown, JavaFile>()
  private declared = new Map<string, Map<string, Node[]>>()

  private unjudged: { why: string; at?: Node }[] = []
  private byType = new Map<string, Node[]>()

  constructor(sources: { path: string; text: string }[]) {
    this.files = sources.map((s) => parseJava(s.path, s.text))
    for (const f of this.files) this.byTree.set(f.tree, f)
  }

  /**
   * For a check: this piece can't be judged, and why. `return project.couldNotJudge('why')`. A whole-project check
   * says which piece: `project.couldNotJudge('why', node)`.
   */
  couldNotJudge(why: string, at?: Node): undefined {
    this.unjudged.push({ why, at })
    return undefined
  }

  /** For the runner (rule.ts): what checks couldn't judge since it last asked. */
  takeUnjudged(): { why: string; at?: Node }[] {
    return this.unjudged.splice(0)
  }

  /** Every field's `variable_declarator` with this name, in any class or interface. */
  fieldsNamed(name: string): Node[] {
    return this.index('field').get(name) ?? []
  }

  /** Every `method_declaration` with this name, in any class. */
  methodsNamed(name: string): Node[] {
    return this.index('method').get(name) ?? []
  }

  /**
   * The one class (or interface) in the project a name means, or null when there is none (a library's) or more than
   * one. The name can say which classes it is inside: `Constants.Shooter` is the Shooter inside Constants even when a
   * Shooter subsystem exists too, and `frc.robot.Constants` is the Constants in the package frc.robot.
   */
  classNamed(name: string | null): Node | null {
    const candidates = name ? (this.index('class').get(name.split('.').pop() ?? '') ?? []) : []
    const found = candidates.filter((c) => `.${fullName(c)}`.endsWith(`.${name}`))
    return found.length === 1 ? found[0] : null
  }

  /** A class and the project classes above it (`Robot`, then its superclass when the project has it), nearest first. */
  lineage(cls: Node | null): Node[] {
    const chain: Node[] = []
    for (let at = cls; at && chain.length < MOST_ANCESTORS; at = this.classNamed(superclassName(at))) chain.push(at)
    return chain
  }

  /**
   * Methods (or fields' declarators) named `name` in a class or the project classes above it, nearest first. A field
   * can also be a constant of an interface one of them implements (`class Shooter implements RobotMap`).
   */
  membersNamed(cls: Node | null, kind: 'method_declaration' | 'field_declaration', name: string): Node[] {
    const members = kind === 'method_declaration' ? this.methodsNamed(name) : this.fieldsNamed(name)
    const own = (c: Node) => members.filter((m) => enclosing(m, BODIES)?.parent?.equals(c))
    const owners = kind === 'field_declaration' ? this.withInterfaces(this.lineage(cls)) : this.lineage(cls)
    return owners.flatMap(own)
  }

  /** These classes, each followed by the project interfaces it implements (and the interfaces those extend). */
  private withInterfaces(classes: Node[]): Node[] {
    const all: Node[] = []
    const add = (owner: Node) => {
      if (all.some((o) => o.equals(owner))) return
      all.push(owner)
      for (const name of interfaceNames(owner)) {
        const found = this.classNamed(name)
        if (found) add(found)
      }
    }
    classes.forEach(add)
    return all
  }

  /** Every node of one type, in every file: `nodes('object_creation_expression')`. */
  nodes(type: string): Node[] {
    const known = this.byType.get(type)
    if (known) return known
    const found = this.files.flatMap((f) => f.tree.rootNode.descendantsOfType(type).filter((n) => n !== null))
    this.byType.set(type, found)
    return found
  }

  fileOf(node: Node): JavaFile {
    const file = this.byTree.get(node.tree)
    if (!file) throw new Error('that node is not from this project')
    return file
  }

  /** Frees the parsed trees (tree-sitter keeps them in wasm memory, which nothing else frees). */
  close(): void {
    for (const f of this.files) f.tree.delete()
  }

  /** Declarations of one kind by name, built the first time they are asked for. */
  private index(kind: keyof typeof DECLARED): Map<string, Node[]> {
    const known = this.declared.get(kind)
    if (known) return known
    const byName = new Map<string, Node[]>()
    for (const declaration of DECLARED[kind].flatMap((type) => this.nodes(type))) {
      const named = kind === 'field' ? parts(declaration).filter((c) => c.type === 'variable_declarator') : [declaration]
      for (const node of named) {
        const name = node && nameOf(node)
        if (node && name) byName.set(name, [...(byName.get(name) ?? []), node])
      }
    }
    this.declared.set(kind, byName)
    return byName
  }
}

/** A class's name with its package and the classes it is inside: "frc.robot.Constants.Shooter". */
function fullName(cls: Node): string {
  const names: string[] = []
  for (let at: Node | null = cls; at; at = ownerAround(at)) names.unshift(nameOf(at) ?? '')
  const pack = parts(cls.tree.rootNode).find((n) => n.type === 'package_declaration')
  return [pack && parts(pack)[0]?.text, ...names].filter(Boolean).join('.')
}

/** The interfaces a class implements, or an interface extends, as written without type arguments: "frc.robot.RobotMap". */
function interfaceNames(owner: Node): string[] {
  const list = parts(owner).find((p) => p.type === 'super_interfaces' || p.type === 'extends_interfaces')
  return parts(parts(list ?? null)[0] ?? null).map((t) => t.text.replace(/<.*$/s, ''))
}
