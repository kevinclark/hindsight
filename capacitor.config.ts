import type { CapacitorConfig } from '@capacitor/cli'

// The iPhone app: the phone build of the page (npm run build:phone → dist-phone/) in a WKWebView. Network requests to
// Google, The Blue Alliance and Nexus go through the app's own native plugin (src/phone/native-fetch.ts), not
// CapacitorHttp, so its fetch patch stays off.
const config: CapacitorConfig = {
  appId: 'io.github.kevinclark.hindsight',
  appName: 'Hindsight',
  webDir: 'dist-phone',
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  plugins: { CapacitorHttp: { enabled: false } },
}

export default config
