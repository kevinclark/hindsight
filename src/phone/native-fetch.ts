/**
 * `fetch` over the app's native HTTP, and the router that decides which requests take it. Not forced by CORS: measured
 * 2026-11-08, Google's token endpoint, Drive, The Blue Alliance and Nexus all allow capacitor://localhost, and the
 * WebView's own fetch read the token endpoint's answer. Kept as insurance against a vendor changing that, for reads with
 * no cache and no cookies, and so every request the phone makes to the outside is one path with one host list. The native
 * side hands back the bytes as they arrived, whatever the content type (Capacitor's own HTTP plugin parses any
 * application/json answer, which would break the byte-exact sha-256 check on Drive's files: HttpRequestHandler.swift,
 * `buildResponse`).
 */
import type { NativeHttp } from './native.ts'

/** The only hosts native HTTP is used for (the Swift side checks the same list). */
export const NATIVE_HOSTS = ['www.googleapis.com', 'oauth2.googleapis.com', 'www.thebluealliance.com', 'frc.nexus'] as const

export function goesNative(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (NATIVE_HOSTS as readonly string[]).includes(u.hostname)
  } catch { return false }
}

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const NO_BODY = new Set([101, 204, 205, 304])

/** A `fetch` that goes through the native side: https to the allowed hosts only, nothing else. */
export function nativeFetch(native: NativeHttp): typeof fetch {
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : null
    const url = urlOf(input)
    if (!goesNative(url)) throw new TypeError(`not sent: ${url.split('?')[0]} is not a host the phone talks to`)
    // A Request carries its own method, headers and body; init overrides them, as fetch does.
    const merged = new Request(url, { method: init.method ?? request?.method ?? 'GET', headers: init.headers ?? request?.headers, body: init.body ?? (request ? await request.arrayBuffer().then((b) => (b.byteLength ? b : null)) : null) })
    const headers: Record<string, string> = {}
    merged.headers.forEach((v, k) => { headers[k] = v })
    const bytes = merged.body ? new Uint8Array(await merged.arrayBuffer()) : null
    let res
    try {
      res = await native.http({ url, method: merged.method.toUpperCase(), headers, ...(bytes ? { body: toBase64(bytes) } : {}) })
    } catch (e) {
      throw new TypeError(`network: ${e instanceof Error ? e.message : String(e)}`)
    }
    const body = NO_BODY.has(res.status) ? null : fromBase64(res.body)
    return new Response(body as BodyInit | null, { status: res.status, headers: res.headers })
  }
}

/** The page's fetch on the phone: the allowed hosts natively, everything else (the app's own files, data: URLs) as before. */
export function routedFetch(original: typeof fetch, native: typeof fetch): typeof fetch {
  return (input, init) => (goesNative(urlOf(input)) ? native(input, init) : original(input, init))
}
