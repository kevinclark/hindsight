// The iPhone app's steps: signed out → team folder → the read-only pages; a refused sign-in; sign out forgets the account.
import { describe, expect, it } from 'vitest'
import { PhoneSession, type SessionDeps } from '../src/phone/session.svelte.ts'
import { SignInAgain } from '../src/hub/adapter.ts'
import { reversedClientId, GOOGLE_IOS_CLIENT_ID } from '../src/phone/google.ts'
import type { HindsightNative } from '../src/phone/native.ts'
import type { TeamFolder } from '../src/phone/setup.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

function world(opts: { signedIn?: boolean; folder?: TeamFolder; sheet?: 'ok' | 'cancel'; refresh?: 'ok' | 'refused' } = {}) {
  const drive = new FakeDrive()
  const team = drive.addFolder('root', 'team')
  const keychain = new Map<string, string>(opts.signedIn ? [['google.refresh', 'r0']] : [])
  const kv = new Map<string, string>(opts.folder ? [['hindsight.phone.teamFolder', JSON.stringify(opts.folder)]] : [])
  const log: string[] = []
  const native: HindsightNative = {
    http: async () => { throw new Error('not used') },
    signIn: async ({ url }) => {
      log.push('sheet')
      if (opts.sheet === 'cancel') throw Object.assign(new Error('sign-in closed'), { code: 'CANCELLED' })
      return { url: `${reversedClientId(GOOGLE_IOS_CLIENT_ID)}:/oauth2redirect?code=c&state=${new URL(url).searchParams.get('state')}` }
    },
    secretGet: async ({ key }) => ({ value: keychain.get(key) ?? null }),
    secretSet: async ({ key, value }) => { keychain.set(key, value) },
    secretDelete: async ({ key }) => { keychain.delete(key) },
  }
  const f: typeof fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const grant = new URLSearchParams(String(init?.body)).get('grant_type')
      if (grant === 'refresh_token' && opts.refresh === 'refused') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      return new Response(JSON.stringify({ access_token: 'good', refresh_token: 'r1', expires_in: 3600 }))
    }
    return drive.fetch(url, init)
  }
  const deps: SessionDeps = {
    native, fetch: f,
    store: { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => { kv.set(k, v) }, removeItem: (k) => { kv.delete(k) } },
    install: (folder) => { log.push(`install ${folder.name}`) },
    clearCopies: async () => { log.push('clear copies') },
    reload: () => { log.push('reload') },
  }
  return { session: new PhoneSession(deps), keychain, kv, log, team }
}

describe('PhoneSession', () => {
  it('signed out: sign in, pick the team folder, then the pages over that folder', async () => {
    const { session, keychain, log, team } = world()
    await session.begin()
    expect(session.step).toBe('signed-out')
    await session.signIn()
    expect(session.step).toBe('folder')
    expect(keychain.get('google.refresh')).toBe('r1')
    await session.pick(`https://drive.google.com/drive/folders/${team}`)
    expect(session.step).toBe('ready')
    expect(log).toEqual(['sheet', 'install team'])
  })

  it('signed in with a saved folder: straight to the pages, no sheet', async () => {
    const { session, log } = world({ signedIn: true, folder: { id: 'x', name: 'Team' } })
    await session.begin()
    expect(session.step).toBe('ready')
    expect(log).toEqual(['install Team'])
  })

  it('closing Google\'s sheet is not an error', async () => {
    const { session } = world({ sheet: 'cancel' })
    await session.begin()
    await session.signIn()
    expect(session.step).toBe('signed-out')
    expect(session.problem).toBeNull()
    expect(session.busy).toBe(false)
  })

  it('a refused sign-in while choosing the folder goes back to the sign-in step (no dead end)', async () => {
    const { session, team } = world({ signedIn: true, refresh: 'refused' })
    await session.begin()
    expect(session.step).toBe('folder')
    await session.pick(`https://drive.google.com/drive/folders/${team}`)
    expect(session.step).toBe('signed-out')
    expect(session.problem).toBeNull()
  })

  it('a refused sign-in on the pages keeps them and asks; signing in again starts the pages over', async () => {
    const { session, log } = world({ signedIn: true, folder: { id: 'x', name: 'Team' }, refresh: 'refused' })
    await session.begin()
    expect(await session.token().catch((e) => e)).toBeInstanceOf(SignInAgain)
    expect(session.step).toBe('ready')
    expect(session.askAgain).toBe(true)
    await session.signIn()
    expect(log.at(-1)).toBe('reload')
  })

  it('sign out forgets the account on this phone: refresh token, team folder, copies of the team files', async () => {
    const { session, keychain, kv, log } = world({ signedIn: true, folder: { id: 'x', name: 'Team' } })
    await session.begin()
    await session.signOut()
    expect(keychain.size).toBe(0)
    expect(kv.has('hindsight.phone.teamFolder')).toBe(false)
    expect(log.slice(-2)).toEqual(['clear copies', 'reload'])
  })

  it('change folder forgets only the folder', async () => {
    const { session, keychain, kv, log } = world({ signedIn: true, folder: { id: 'x', name: 'Team' } })
    await session.begin()
    session.changeFolder()
    expect(kv.has('hindsight.phone.teamFolder')).toBe(false)
    expect(keychain.size).toBe(1)
    expect(log.at(-1)).toBe('reload')
  })
})
