import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'

// One self-contained HTML file (dist/index.html, copied to hindsight.html) so the app runs from file:// offline.
export default defineConfig({
  base: './',
  plugins: [svelte(), viteSingleFile()],
  // A new build can read logs differently, so the browser's cached summaries are kept per build.
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  build: { target: 'es2022' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
