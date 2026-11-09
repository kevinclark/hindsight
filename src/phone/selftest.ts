/**
 * A build of the iPhone app that checks its native bridge on a real iOS WebView (PHONE_BUILD=selftest): bytes arrive
 * exactly (a JSON answer and a binary one, compared with the same files fetched on a computer), a form POST reaches Google's
 * token endpoint and its refusal reads as SignInAgain, the WebView's own fetch is refused there (why native HTTP exists),
 * the native side refuses a host outside its list, and the Keychain keeps, returns and deletes a value. It prints one line
 * per check, on the page and to the console (Xcode and `simctl launch --console` show it). Touches no account.
 */
import { SignInAgain } from '../hub/adapter.ts'
import { sha256Hex } from '../hub/phone-cache.ts'
import { refreshAccess } from '../hub/oauth.ts'
import { GOOGLE_IOS_CLIENT_ID } from './google.ts'
import type { HindsightNative } from './native.ts'

const CHECKS: { name: string; run(native: HindsightNative, viaNative: typeof fetch): Promise<string> }[] = [
  {
    name: 'JSON answer, byte for byte',
    async run(_n, f) {
      const res = await f('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest')
      const bytes = new Uint8Array(await res.arrayBuffer())
      return `status ${res.status}, ${res.headers.get('content-type')}, ${bytes.length} bytes, sha256 ${await sha256Hex(bytes)}`
    },
  },
  {
    name: 'binary answer, byte for byte',
    async run(_n, f) {
      const res = await f('https://www.thebluealliance.com/favicon.ico')
      const bytes = new Uint8Array(await res.arrayBuffer())
      return `status ${res.status}, ${res.headers.get('content-type')}, ${bytes.length} bytes, sha256 ${await sha256Hex(bytes)}`
    },
  },
  {
    name: 'Range header sent',
    async run(_n, f) {
      const res = await f('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest', { headers: { Range: 'bytes=100-199' } })
      const bytes = new Uint8Array(await res.arrayBuffer())
      return `status ${res.status}, content-range ${res.headers.get('content-range') ?? 'none'}, ${bytes.length} bytes`
    },
  },
  {
    name: 'token endpoint by native HTTP (a made-up refresh token)',
    async run(_n, f) {
      try { await refreshAccess({ id: GOOGLE_IOS_CLIENT_ID }, 'not-a-real-refresh-token', Date.now(), f); return 'FAIL: accepted' } catch (e) {
        return e instanceof SignInAgain ? 'PASS: Google answered invalid_grant (SignInAgain)' : `FAIL: ${String(e)}`
      }
    },
  },
  {
    name: "token endpoint by the WebView's own fetch",
    async run() {
      const original = Object.getPrototypeOf(globalThis).fetch as typeof fetch | undefined
      if (!original) return 'skipped: no WebView fetch found'
      try { const r = await original.call(globalThis, 'https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) }); return `answered ${r.status} (CORS did not block it)` } catch (e) { return `refused: ${String(e)}` }
    },
  },
  {
    name: 'native side refuses a host outside its list',
    async run(n) {
      try { await n.http({ url: 'https://example.com/', method: 'GET', headers: {} }); return 'FAIL: it was sent' } catch (e) { return `PASS: ${String(e)}` }
    },
  },
  {
    name: 'Keychain keeps, returns and deletes',
    async run(n) {
      const key = 'selftest.probe'
      await n.secretSet({ key, value: 'kept ✓' })
      const got = (await n.secretGet({ key })).value
      await n.secretDelete({ key })
      const gone = (await n.secretGet({ key })).value
      return got === 'kept ✓' && gone === null ? 'PASS' : `FAIL: got ${JSON.stringify(got)}, after delete ${JSON.stringify(gone)}`
    },
  },
]

export async function runSelftest(native: HindsightNative, viaNative: typeof fetch, target: HTMLElement): Promise<void> {
  const list = document.createElement('ol')
  target.replaceChildren(Object.assign(document.createElement('h1'), { textContent: 'Hindsight bridge self-test' }), list)
  for (const c of CHECKS) {
    let result: string
    try { result = await c.run(native, viaNative) } catch (e) { result = `FAIL: ${e instanceof Error ? e.message : String(e)}` }
    list.append(Object.assign(document.createElement('li'), { textContent: `${c.name}: ${result}` }))
    console.log(`HINDSIGHT-SELFTEST ${c.name}: ${result}`)
  }
  console.log('HINDSIGHT-SELFTEST done')
}
