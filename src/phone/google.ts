/**
 * Google sign-in on the iPhone app. Google refuses sign-in inside a WKWebView (`disallowed_useragent`), so the app's native
 * plugin opens it in ASWebAuthenticationSession, which hands back the redirect to the iOS client's reversed id. PKCE, no
 * secret (an iOS client has none), scope drive.readonly: the phone reads the team folder and writes nothing. The refresh
 * token lives in the Keychain only; the access token only in memory.
 *
 * The client id is public by design: an iOS client is identified by it and the app's bundle id, and it is also in
 * ios/App/App/Info.plist as the URL scheme.
 */
import { SignInAgain } from '../hub/adapter.ts'
import { READ_SCOPE, authUrl, exchangeCode, newPkce, randomToken, tokenSource, type Client } from '../hub/oauth.ts'
import type { HindsightNative } from './native.ts'

/** Google Cloud project hindsight-512414, iOS client for io.github.kevinclark.hindsight. */
export const GOOGLE_IOS_CLIENT_ID = '948803611909-ufa595ibhklqehal25p89de9tnaasrcf.apps.googleusercontent.com'
const CLIENT: Client = { id: GOOGLE_IOS_CLIENT_ID }
/**
 * The one scope the phone asks for. drive.readonly is not declared on the consent screen (declaring it starts Google's
 * restricted-scope verification); only `drive` is. Tried first at the first real sign-in: whatever Google answers there
 * is pinned here and in docs/privacy.md, with no fallback at run time. Either way the phone's Drive client sends only GETs
 * (src/hub/drive-read.ts `isReadOnlyRequest`).
 */
export const PHONE_SCOPE = READ_SCOPE
const REFRESH = 'google.refresh'

/** `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc`: the scheme Google redirects an iOS client to. */
export const reversedClientId = (id: string): string => id.split('.').reverse().join('.')
export const redirectUri = (id: string): string => `${reversedClientId(id)}:/oauth2redirect`

type Keychain = Pick<HindsightNative, 'secretGet' | 'secretSet' | 'secretDelete'>

const keychainStore = (native: Keychain) => ({
  load: async () => (await native.secretGet({ key: REFRESH })).value,
  save: (refresh: string) => native.secretSet({ key: REFRESH, value: refresh }),
  clear: () => native.secretDelete({ key: REFRESH }),
})

export const isSignedIn = async (native: Keychain): Promise<boolean> => !!(await native.secretGet({ key: REFRESH })).value
export const signOut = (native: Keychain): Promise<void> => native.secretDelete({ key: REFRESH })

/** Sign in with Google and keep the refresh token in the Keychain. `doFetch` reaches Google's token endpoint (native HTTP on the phone). */
export async function signIn(native: HindsightNative, doFetch: typeof fetch): Promise<void> {
  const { verifier, challenge } = await newPkce()
  const state = randomToken(16)
  const redirect = redirectUri(CLIENT.id)
  const { url } = await native.signIn({ url: authUrl(CLIENT, redirect, challenge, state, PHONE_SCOPE), scheme: reversedClientId(CLIENT.id) })
  const answer = new URL(url).searchParams
  if (answer.get('state') !== state) throw new Error('Google answered, but not the sign-in this app started. Try again.')
  const error = answer.get('error')
  const code = answer.get('code')
  if (error || !code) throw new Error(`Google sign-in was not completed (${error ?? 'no code'}).`)
  const tokens = await exchangeCode(CLIENT, code, verifier, redirect, Date.now(), doFetch)
  if (!tokens.refresh) throw new Error('Google gave no refresh token: sign in again and allow access.')
  await keychainStore(native).save(tokens.refresh)
}

/** An access token for the Drive reader, renewed from the Keychain's refresh token; throws SignInAgain when there is none or Google refuses it. */
export function phoneToken(native: Keychain, doFetch: typeof fetch): (refresh?: boolean) => Promise<string> {
  // What Google granted, in the app's console (Xcode, `devicectl … launch --console`): drive.readonly is not declared on the consent screen.
  return tokenSource(CLIENT, keychainStore(native), doFetch, Date.now, (scope) => console.log(`Hindsight: Google granted ${scope}`))
}

export { SignInAgain }
