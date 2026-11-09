/**
 * The iPhone app's page (phone.html, vite.phone.config.ts). The same pages as the laptop's, read only, over the team's
 * Drive; requests to Google, The Blue Alliance and Nexus go through the app's native HTTP (src/phone/native-fetch.ts).
 */
import { mount } from 'svelte'

declare const __PHONE_BUILD__: 'native' | 'fixture' | 'selftest'

const target = document.getElementById('app')!
target.classList.add('phone')

if (__PHONE_BUILD__ === 'fixture') {
  ;(await import('./phone-fixture.ts')).installFixture()
  const { default: App } = await import('./App.svelte')
  mount(App, { target })
} else {
  const { native, viaNative } = await import('./phone/runtime.ts')
  const { routedFetch } = await import('./phone/native-fetch.ts')
  const webFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = routedFetch(webFetch, viaNative)
  if (__PHONE_BUILD__ === 'selftest') await (await import('./phone/selftest.ts')).runSelftest(native, viaNative, webFetch, target)
  else {
    const { default: PhoneShell } = await import('./phone/PhoneShell.svelte')
    mount(PhoneShell, { target })
  }
}
