import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A hash of the app's source: a build that reads logs the same way keeps the browser's saved summaries.
function sourceHash(dir = 'src'): string {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (name.name.startsWith('.')) continue // .DS_Store and the like aren't code
      const path = join(d, name.name)
      if (name.isDirectory()) walk(path)
      else { hash.update(path); hash.update(readFileSync(path)) }
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 16)
}

// One self-contained HTML file (dist/index.html, copied to hindsight.html) so the app runs from file:// offline.
export default defineConfig({
  base: './',
  plugins: [svelte(), viteSingleFile()],
  // Saved summaries are kept per version of the source: changed code may read logs differently.
  define: { __BUILD_ID__: JSON.stringify(sourceHash()) },
  build: { target: 'es2022' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
