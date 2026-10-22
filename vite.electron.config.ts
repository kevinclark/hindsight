import { defineConfig } from 'vite'
import { sourceHash } from './vite.build-id.ts'

// The desktop app's own code (electron/): the window, the library service and the workers, as CommonJS next to each other.
// The page is built by vite.config.ts; node modules and electron stay outside the bundle.
export default defineConfig({
  // The Desktop OAuth client of the build (Google treats a Desktop client's secret as public). From the environment, so it is carried
  // in the release artifact and never committed; a team can also type its own in the app.
  define: {
    // Names the describer that wrote a `meta` record: the same hash of src/ the page's saved summaries use.
    __BUILD_ID__: JSON.stringify(sourceHash()),
    __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.HINDSIGHT_GOOGLE_CLIENT_ID ?? ''),
    __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.HINDSIGHT_GOOGLE_CLIENT_SECRET ?? ''),
  },
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
