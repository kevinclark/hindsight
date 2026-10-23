import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { sourceHash } from './vite.build-id.ts'

// web-tree-sitter finds its .wasm with `new URL(..., import.meta.url)`, which would inline a second 279 KB copy: the code
// check passes the bytes itself (src/code/check/browser-java.ts), so that reference goes. Fails if a new version moved it.
const TREE_SITTER_WASM_URL = 'new URL("web-tree-sitter.wasm", import.meta.url).href'
const oneTreeSitterWasm = {
  name: 'one-tree-sitter-wasm',
  transform(code: string, id: string) {
    if (!id.includes('/web-tree-sitter/web-tree-sitter.js')) return null
    if (!code.includes(TREE_SITTER_WASM_URL)) throw new Error('web-tree-sitter no longer finds its wasm the way vite.config.ts expects')
    return code.replace(TREE_SITTER_WASM_URL, '"web-tree-sitter.wasm"')
  },
}

// One self-contained HTML file (dist/index.html, copied to hindsight.html) so the app runs from file:// offline.
export default defineConfig({
  base: './',
  plugins: [svelte(), viteSingleFile(), oneTreeSitterWasm],
  // Saved summaries are kept per version of the source: changed code may read logs differently.
  define: { __BUILD_ID__: JSON.stringify(sourceHash()) },
  build: { target: 'es2022' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
