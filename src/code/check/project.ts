/**
 * All the Java files of one commit, parsed, with an index of what they declare by name: fields, methods and classes.
 * The rules ask it where a name is declared (`fieldsNamed('GEAR_RATIO')`) and which file a node is in (`fileOf`).
 */
import { enclosing, nameOf, parseJava, parts, superclassName, type JavaFile, type Node } from './java.ts'

/** How many superclasses up `lineage` looks (and where a cycle stops). */
const MOST_ANCESTORS = 8

/** A type without its type arguments or package: "Matrix<N3, N1>" is "Matrix", "frc.robot.Robot" is "Robot". */
export const baseType = (type: string | null | undefined) => type?.replace(/<.*$/s, '').split('.').pop()?.trim() || null

export class Project {
  readonly files: JavaFile[]
  private byTree = new Map<unknown, JavaFile>()
  private declared = new Map<string, Map<string, Node[]>>()

  private unjudged: { why: string; at?: Node }[] = []

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

  /** Every field's `variable_declarator` with this name, in any class. */
  fieldsNamed(name: string): Node[] {
    return this.index('field_declaration').get(name) ?? []
  }

  /** Every `method_declaration` with this name, in any class. */
  methodsNamed(name: string): Node[] {
    return this.index('method_declaration').get(name) ?? []
  }

  /** The one class with this name in the project, or null when there is none (a library's) or more than one. */
  classNamed(name: string | null): Node | null {
    const found = name ? (this.index('class_declaration').get(name) ?? []) : []
    return found.length === 1 ? found[0] : null
  }

  /** A class and the project classes above it (`Robot`, then its superclass when the project has it), nearest first. */
  lineage(cls: Node | null): Node[] {
    const chain: Node[] = []
    for (let at = cls; at && chain.length < MOST_ANCESTORS; at = this.classNamed(superclassName(at))) chain.push(at)
    return chain
  }

  /** Methods (or fields' declarators) named `name` in a class or the project classes above it, nearest first. */
  membersNamed(cls: Node | null, kind: 'method_declaration' | 'field_declaration', name: string): Node[] {
    const own = (c: Node) => (kind === 'method_declaration' ? this.methodsNamed(name) : this.fieldsNamed(name)).filter((m) => enclosing(m, ['class_body'])?.parent?.equals(c))
    return this.lineage(cls).flatMap(own)
  }

  /** Every node of one type, in every file: `nodes('object_creation_expression')`. */
  nodes(type: string): Node[] {
    return this.files.flatMap((f) => f.tree.rootNode.descendantsOfType(type).filter((n) => n !== null))
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
  private index(kind: string): Map<string, Node[]> {
    const known = this.declared.get(kind)
    if (known) return known
    const byName = new Map<string, Node[]>()
    for (const declaration of this.nodes(kind)) {
      const named = kind === 'field_declaration' ? parts(declaration).filter((c) => c.type === 'variable_declarator') : [declaration]
      for (const node of named) {
        const name = node && nameOf(node)
        if (node && name) byName.set(name, [...(byName.get(name) ?? []), node])
      }
    }
    this.declared.set(kind, byName)
    return byName
  }
}
