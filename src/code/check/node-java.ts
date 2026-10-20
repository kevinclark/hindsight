/** loadJava for the node scripts and tests: the two .wasm files read from node_modules. The page uses browser-java.ts. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadJava } from './java.ts'

export function loadJavaFromDisk(): Promise<void> {
  const require = createRequire(import.meta.url)
  const read = (module: string) => new Uint8Array(readFileSync(require.resolve(module)))
  return loadJava(read('web-tree-sitter/web-tree-sitter.wasm'), read('tree-sitter-java-orchard/tree-sitter-java_orchard.wasm'))
}
