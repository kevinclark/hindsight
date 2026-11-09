/**
 * The iPhone app's own native plugin (ios/App/App/HindsightNativePlugin.swift), as the page sees it. Three jobs the WebView
 * can't do: HTTP that CORS doesn't apply to and that hands back raw bytes, Google's sign-in in ASWebAuthenticationSession
 * (Google refuses sign-in inside a WKWebView), and the Keychain. Bodies cross the bridge as base64.
 */
import { registerPlugin } from '@capacitor/core'

export interface NativeHttpRequest {
  url: string
  method: string
  /** Lower-case names. */
  headers: Record<string, string>
  /** base64; absent for no body. */
  body?: string
}

export interface NativeHttpResponse {
  status: number
  headers: Record<string, string>
  /** base64 of the bytes exactly as they arrived. */
  body: string
}

export interface NativeHttp {
  http(req: NativeHttpRequest): Promise<NativeHttpResponse>
}

export interface HindsightNative extends NativeHttp {
  /** Open `url` in ASWebAuthenticationSession; resolves with the URL Google redirected to (scheme `scheme`). Rejects with code CANCELLED when the person closes it. */
  signIn(opts: { url: string; scheme: string }): Promise<{ url: string }>
  secretGet(opts: { key: string }): Promise<{ value: string | null }>
  secretSet(opts: { key: string; value: string }): Promise<void>
  secretDelete(opts: { key: string }): Promise<void>
}

export const hindsightNative = (): HindsightNative => registerPlugin<HindsightNative>('HindsightNative')
