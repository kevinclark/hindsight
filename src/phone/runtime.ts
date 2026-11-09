/**
 * The iPhone app's native plugin, the fetch over it, and the WebView's own fetch (taken before phone-main routes the
 * page's fetch): made once, used by the shell and the router.
 */
import { hindsightNative } from './native.ts'
import { nativeFetch } from './native-fetch.ts'

export const native = hindsightNative()
export const viaNative = nativeFetch(native)
export const webFetch: typeof fetch = globalThis.fetch.bind(globalThis)
