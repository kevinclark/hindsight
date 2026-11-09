// The phone's Google sign-in: the iOS client (no secret), drive.readonly, PKCE, ASWebAuthenticationSession through the
// native plugin, the redirect on the reversed client id, the refresh token in the Keychain and nowhere else.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { GOOGLE_IOS_CLIENT_ID, phoneToken, redirectUri, reversedClientId, signIn, signOut, isSignedIn } from '../src/phone/google.ts'
import { SignInAgain } from '../src/hub/adapter.ts'
import type { HindsightNative } from '../src/phone/native.ts'
import { chooseFolder, forgetFolder, savedFolder } from '../src/phone/setup.ts'

function fakeNative(answer: (authUrl: URL) => string | Error) {
  const keychain = new Map<string, string>()
  const opened: { url: URL; scheme: string }[] = []
  const native: HindsightNative = {
    http: async () => { throw new Error('not used') },
    signIn: async ({ url, scheme }) => {
      const u = new URL(url)
      opened.push({ url: u, scheme })
      const a = answer(u)
      if (a instanceof Error) throw a
      return { url: a }
    },
    secretGet: async ({ key }) => ({ value: keychain.get(key) ?? null }),
    secretSet: async ({ key, value }) => { keychain.set(key, value) },
    secretDelete: async ({ key }) => { keychain.delete(key) },
  }
  return { native, keychain, opened }
}

/** Google's token endpoint: records each form body and answers in turn. */
function tokenEndpoint(answers: object[]) {
  const forms: URLSearchParams[] = []
  const f: typeof fetch = async (url, init) => {
    expect(String(url)).toBe('https://oauth2.googleapis.com/token')
    forms.push(new URLSearchParams(String(init?.body)))
    const a = answers.shift()!
    return new Response(JSON.stringify(a), { status: 'error' in a ? 400 : 200 })
  }
  return { f, forms }
}

const back = (u: URL, extra: Record<string, string>) => `${reversedClientId(GOOGLE_IOS_CLIENT_ID)}:/oauth2redirect?${new URLSearchParams({ state: u.searchParams.get('state')!, ...extra })}`

describe('phone sign-in', () => {
  it('reverses the iOS client id into the URL scheme Google redirects to', () => {
    expect(reversedClientId('123-abc.apps.googleusercontent.com')).toBe('com.googleusercontent.apps.123-abc')
    expect(redirectUri('123-abc.apps.googleusercontent.com')).toBe('com.googleusercontent.apps.123-abc:/oauth2redirect')
  })

  it('opens Google with the iOS client, drive.readonly, PKCE and offline access, and keeps the refresh token in the Keychain', async () => {
    const { native, keychain, opened } = fakeNative((u) => back(u, { code: 'the-code' }))
    const { f, forms } = tokenEndpoint([{ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }])
    await signIn(native, f)
    const u = opened[0].url
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(opened[0].scheme).toBe(reversedClientId(GOOGLE_IOS_CLIENT_ID))
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: GOOGLE_IOS_CLIENT_ID, redirect_uri: redirectUri(GOOGLE_IOS_CLIENT_ID), scope: 'https://www.googleapis.com/auth/drive.readonly', response_type: 'code', code_challenge_method: 'S256', access_type: 'offline' })
    const form = Object.fromEntries(forms[0])
    expect(form).toMatchObject({ client_id: GOOGLE_IOS_CLIENT_ID, code: 'the-code', grant_type: 'authorization_code', redirect_uri: redirectUri(GOOGLE_IOS_CLIENT_ID) })
    expect(createHash('sha256').update(form.code_verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'))
    expect('client_secret' in form).toBe(false)
    expect([...keychain]).toEqual([['google.refresh', 'r1']])
    expect(await isSignedIn(native)).toBe(true)
  })

  it('refuses an answer whose state is not the one it sent, and a refusal from Google, keeping nothing', async () => {
    const forged = fakeNative(() => `${reversedClientId(GOOGLE_IOS_CLIENT_ID)}:/oauth2redirect?code=x&state=forged`)
    const t = tokenEndpoint([])
    await expect(signIn(forged.native, t.f)).rejects.toThrow(/not the sign-in this app started/)
    expect(t.forms).toEqual([])
    const denied = fakeNative((u) => back(u, { error: 'access_denied' }))
    await expect(signIn(denied.native, t.f)).rejects.toThrow(/access_denied/)
    expect(denied.keychain.size + forged.keychain.size).toBe(0)
  })

  it('fails without a refresh token rather than signing in for one hour', async () => {
    const { native, keychain } = fakeNative((u) => back(u, { code: 'c' }))
    await expect(signIn(native, tokenEndpoint([{ access_token: 'a', expires_in: 3600 }]).f)).rejects.toThrow(/refresh token/)
    expect(keychain.size).toBe(0)
  })

  it('renews the access token from the Keychain through the injected fetch; invalid_grant clears it and asks to sign in again', async () => {
    const { native, keychain } = fakeNative(() => new Error('unused'))
    keychain.set('google.refresh', 'r1')
    const { f, forms } = tokenEndpoint([{ access_token: 'a1', expires_in: 3600 }, { error: 'invalid_grant' }])
    const token = phoneToken(native, f)
    expect(await token()).toBe('a1')
    expect(forms[0].get('refresh_token')).toBe('r1')
    expect(await token(true).catch((e) => e)).toBeInstanceOf(SignInAgain)
    expect(keychain.size).toBe(0)
    expect(await isSignedIn(native)).toBe(false)
  })

  it('signs out by deleting the refresh token from the Keychain', async () => {
    const { native, keychain } = fakeNative(() => new Error('unused'))
    keychain.set('google.refresh', 'r1')
    await signOut(native)
    expect(keychain.size).toBe(0)
  })

  it("the app's Info.plist registers the reversed client id as its URL scheme", () => {
    const plist = 'ios/App/App/Info.plist'
    expect(existsSync(plist)).toBe(true)
    expect(readFileSync(plist, 'utf8')).toContain(`<string>${reversedClientId(GOOGLE_IOS_CLIENT_ID)}</string>`)
  })
})

describe('phone team folder', () => {
  const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m } }

  it('takes a pasted folder link or id, keeps only a folder Drive shows this account, and remembers its id and name', async () => {
    const reader = { describeFolder: async (id: string) => (id === 'team-folder-id1' ? { id, name: 'Team' } : null) }
    const s = store()
    expect(await chooseFolder(reader, 'https://drive.google.com/drive/folders/team-folder-id1?usp=sharing', s)).toEqual({ id: 'team-folder-id1', name: 'Team' })
    expect(savedFolder(s)).toEqual({ id: 'team-folder-id1', name: 'Team' })
    await expect(chooseFolder(reader, 'not a link', s)).rejects.toThrow(/not a Drive folder link/)
    await expect(chooseFolder(reader, 'other-folder-id9', s)).rejects.toThrow(/cannot show that folder/)
    expect(savedFolder(s)).toEqual({ id: 'team-folder-id1', name: 'Team' })
    forgetFolder(s)
    expect(savedFolder(s)).toBeNull()
  })

  it('reads a damaged saved folder as none', () => {
    const s = store()
    s.setItem('hindsight.phone.teamFolder', '{"id":')
    expect(savedFolder(s)).toBeNull()
    s.setItem('hindsight.phone.teamFolder', '{"name":"x"}')
    expect(savedFolder(s)).toBeNull()
  })
})
