import { defineConfig } from 'vite'

// The desktop app's own code (electron/): the window, the library service and the workers, as CommonJS next to each other.
// The page is built by vite.config.ts; node modules and electron stay outside the bundle.
export default defineConfig({
  build: {
    outDir: 'dist-electron',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    lib: {
      entry: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'describe-worker': 'electron/describe-worker.ts' },
      formats: ['cjs'],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rollupOptions: { external: [/^node:/, 'electron', 'ssh2'] },
  },
})
