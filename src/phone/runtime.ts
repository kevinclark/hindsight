/** The iPhone app's native plugin and the fetch over it: made once, used by the shell and by phone-main's fetch router. */
import { hindsightNative } from './native.ts'
import { nativeFetch } from './native-fetch.ts'

export const native = hindsightNative()
export const viaNative = nativeFetch(native)
