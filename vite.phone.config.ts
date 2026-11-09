import { mergeConfig } from 'vite'
import base from './vite.config.ts'

// The iPhone app's page (Capacitor serves dist-phone/ from the app bundle). PHONE_BUILD picks what it runs:
// 'native' (default) signs in and reads the team Drive; 'fixture' shows the invented event (fixtures/phone/), no sign-in;
// 'selftest' checks the native bridge (bytes, the token endpoint, the Keychain) and prints what it found.
const PHONE_BUILDS = ['native', 'fixture', 'selftest']
const build = process.env.PHONE_BUILD ?? 'native'
if (!PHONE_BUILDS.includes(build)) throw new Error(`PHONE_BUILD must be one of ${PHONE_BUILDS.join(', ')}`)

export default mergeConfig(base, {
  define: { __PHONE_BUILD__: JSON.stringify(build) },
  build: { outDir: 'dist-phone', emptyOutDir: true, rollupOptions: { input: 'phone.html' } },
})
