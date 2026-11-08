import { mount } from 'svelte'
import App from './App.svelte'

// Dev only: ?phone-fixture shows the phone's read-only pages over an invented event (src/phone-fixture.ts).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('phone-fixture')) (await import('./phone-fixture.ts')).installFixture()

export default mount(App, { target: document.getElementById('app')! })
