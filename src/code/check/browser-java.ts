/**
 * loadJava for the page: the two .wasm files are inlined in hindsight.html (it runs from file://, where nothing can be
 * fetched) and decoded here, the first time the code check runs. Node uses node-java.ts.
 */
import runtimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import grammarUrl from 'tree-sitter-java-orchard/tree-sitter-java_orchard.wasm?url'
import { loadJava } from './java.ts'

export const loadJavaInPage = () => loadJava(fromDataUrl(runtimeUrl), fromDataUrl(grammarUrl))

/** The bytes of a base64 data: URL, decoded here rather than fetched. */
function fromDataUrl(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
