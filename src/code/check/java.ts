/**
 * Java source as a tree, for the code checks (rules/). tree-sitter's Java grammar names every piece of code by what
 * Java calls it: `50 / 12` in `double GEAR_RATIO = 50 / 12;` is a `binary_expression` with a `left` and a `right`,
 * inside a `variable_declarator`, inside a `field_declaration`. To see the tree of any line of your own code:
 *
 *   node --experimental-strip-types scripts/code-check.ts --tree <folder> File.java:50
 */
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter'

export type { Node }

/** One parsed file. */
export interface JavaFile { path: string; text: string; tree: Tree }

let parser: Parser | null = null
let loading: Promise<void> | null = null

/**
 * Loads tree-sitter and the Java grammar, once, however many checks ask at the same time (two loads at once break
 * tree-sitter). `wasm` gives the two .wasm files: inlined in the page, read from disk under node. A load that fails
 * isn't kept: the next ask tries again.
 */
export function loadJava(wasm: () => Promise<[runtime: Uint8Array, grammar: Uint8Array]>): Promise<void> {
  loading ??= (async () => {
    const [runtime, grammar] = await wasm()
    await Parser.init({ wasmBinary: runtime })
    const java = await Language.load(grammar)
    const ready = new Parser()
    ready.setLanguage(java)
    parser = ready
  })().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

export function parseJava(path: string, text: string): JavaFile {
  if (!parser) throw new Error('loadJava() must run before parseJava()')
  const tree = parser.parse(text)
  if (!tree) throw new Error(`couldn't parse ${path}`)
  return { path, text, tree }
}

/** "IndexerIO.java" from "src/main/java/frc/robot/subsystems/indexer/IndexerIO.java". */
export const fileName = (path: string) => path.split('/').pop() ?? path

/** The line a node starts on, counting from 1 as an editor does. */
export const lineOf = (node: Node) => node.startPosition.row + 1

/** The operator of a binary, unary or assignment expression: '/', '&&', '!', '='. */
export const operatorOf = (node: Node | null) => node?.childForFieldName('operator')?.type ?? null

/** A node's named part: `field(division, 'left')`. */
export const field = (node: Node, name: string) => node.childForFieldName(name)

/** A node's named children (or its named part's: `parts(call, 'arguments')`), leaving out comments. */
export function parts(node: Node | null, name?: string): Node[] {
  const of = node && name ? field(node, name) : node
  return (of?.namedChildren ?? []).filter((c): c is Node => c !== null && !COMMENTS.includes(c.type))
}
const COMMENTS = ['line_comment', 'block_comment']

/** The class a node is in. */
export const classAround = (node: Node) => enclosing(node, ['class_declaration'])

/** The class or interface a node is in: what owns a field or method declared there. */
export const ownerAround = (node: Node) => enclosing(node, ['class_declaration', 'interface_declaration'])

/** The name of the class a class extends, without type arguments, or null. */
export const superclassName = (cls: Node | null) => (cls && parts(cls, 'superclass')[0]?.text.replace(/<.*$/s, '')) || null

/** Does `node` fill this part of its parent? `fills(x, 'left')` for the `x` in `x = 1`. */
export const fills = (node: Node, part: string) => !!node.parent && field(node.parent, part)?.equals(node) === true

/** The name a declaration declares (a variable, a parameter, a method), or a bare identifier's own text. */
export function nameOf(declared: Node): string | null {
  if (declared.type === 'identifier') return declared.text
  return field(declared, 'name')?.text ?? null
}

/** The type a declaration or cast names, as written ("double", "Matrix<N3, N1>"), or null. */
export const typeNamed = (node: Node) => field(node, 'type')?.text ?? null

/** The nearest node above this one of one of these types, or null. */
export function enclosing(node: Node, types: string[]): Node | null {
  for (let at = node.parent; at; at = at.parent) if (types.includes(at.type)) return at
  return null
}

/** True when `inner` is `outer` or somewhere inside it. */
export const isInside = (inner: Node, outer: Node) => inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex

/** Longest code a message quotes before cutting it short with "…". */
const QUOTE_LENGTH = 70

/** The code as written, with runs of spaces and line breaks made one space: for comparing two expressions. */
export const codeOf = (node: Node) => node.text.replace(/\s+/g, ' ')

/** The code as a message quotes it: codeOf, cut short when it is long. */
export function quote(node: Node): string {
  const code = codeOf(node)
  return code.length > QUOTE_LENGTH ? `${code.slice(0, QUOTE_LENGTH - 1)}…` : code
}

/** `final`, `static`, `private`… on a declaration, with '@' for each annotation. */
export function modifiersOf(declaration: Node): string[] {
  const modifiers = parts(declaration).find((c) => c.type === 'modifiers')
  const isAnnotation = (c: Node) => c.type === 'marker_annotation' || c.type === 'annotation'
  return (modifiers?.children ?? []).flatMap((c) => (c ? [isAnnotation(c) ? '@' : c.text] : []))
}
