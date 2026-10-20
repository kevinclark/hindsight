/**
 * loadJava for the page: the two .wasm files are inlined in hindsight.html (it runs from file://, where nothing can be
 * fetched) and decoded here, the first time the code check runs. Under `npm run dev` Vite serves them as files
 * instead, and they are fetched. Node uses node-java.ts.
 */
import runtimeUrl from 'web-tree-sitter/web-tree-sitter.wasm?url'
import grammarUrl from 'tree-sitter-java-orchard/tree-sitter-java_orchard.wasm?url'
import { loadJava } from './java.ts'

export const loadJavaInPage = () => loadJava(async () => [await bytesOf(runtimeUrl), await bytesOf(grammarUrl)])

/** A .wasm's bytes: decoded from a base64 data: URL in the built page, fetched from the dev server. */
async function bytesOf(url: string): Promise<Uint8Array> {
  if (!url.startsWith('data:')) return new Uint8Array(await (await fetch(url)).arrayBuffer())
  const binary = atob(url.slice(url.indexOf(',') + 1))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}
