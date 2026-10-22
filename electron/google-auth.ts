/**
 * Signing in to Google from the desktop app: the system browser, a loopback server for the redirect, PKCE
 * (src/hub/oauth.ts). The refresh token is encrypted with Electron's safeStorage (its key is in the OS keychain) and kept
 * in the app's user-data folder, never in the library. Where safeStorage would only obfuscate (Linux with no keyring:
 * backend `basic_text`) the refresh token is not kept and the user signs in each run.
 */
import { app, safeStorage, shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { authUrl, exchangeCode, newPkce, tokenSource, type Client } from '../src/hub/oauth.ts'
import { loadSettings } from './settings.ts'

const tokenFile = () => join(app.getPath('userData'), 'google-refresh.bin')
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** Whether the refresh token can be kept safely on this machine, and if not, why. */
export function keeping(): { keeps: boolean; why: string | null } {
  if (!safeStorage.isEncryptionAvailable()) return { keeps: false, why: 'This computer has no secure place to keep the sign-in (no keychain).' }
  const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : null
  if (backend === 'basic_text') return { keeps: false, why: 'No keyring was found (Linux), so the sign-in is not kept: you sign in again each time Hindsight starts.' }
  return { keeps: true, why: null }
}

/** The build's Google client, or the team's own if one was typed in. Null when there is neither. */
export async function googleClient(): Promise<Client | null> {
  const own = (await loadSettings()).googleClient
  if (own?.id) return own
  return __GOOGLE_CLIENT_ID__ ? { id: __GOOGLE_CLIENT_ID__, secret: __GOOGLE_CLIENT_SECRET__ } : null
}

let session: string | null = null
const store = {
  async load(): Promise<string | null> {
    if (session) return session
    if (!keeping().keeps) return null
    try { return (session = safeStorage.decryptString(await readFile(tokenFile()))) } catch { return null }
  },
  async save(refresh: string): Promise<void> {
    session = refresh
    if (!keeping().keeps) return
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(tokenFile(), safeStorage.encryptString(refresh), { mode: 0o600 })
  },
  async clear(): Promise<void> { session = null; await rm(tokenFile(), { force: true }) },
}

export async function signedIn(): Promise<boolean> { return (await store.load()) !== null }
export const signOut = () => store.clear()

/** An access token for DriveAdapter, renewed from the stored refresh token. */
export async function driveToken(): Promise<(refresh?: boolean) => Promise<string>> {
  const client = await googleClient()
  if (!client) throw new Error('Google Drive is not set up in this build: no Google client.')
  return tokenSource(client, store)
}

/** Open Google's sign-in in the user's browser and wait for it to come back. */
export async function signIn(): Promise<void> {
  const client = await googleClient()
  if (!client) throw new Error('Google Drive is not set up in this build: no Google client.')
  const { verifier, challenge } = newPkce()
  const state = randomBytes(16).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const redirect = `http://127.0.0.1:${port}`
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT_MS)
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirect)
        if (url.searchParams.get('state') !== state && !url.searchParams.has('error')) { res.writeHead(400).end('Not the sign-in this app started.'); return }
        const error = url.searchParams.get('error')
        const got = url.searchParams.get('code')
        if (!error && !got) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Hindsight</title><p>${error ? 'Sign-in was not completed.' : 'Signed in. You can close this tab and go back to Hindsight.'}</p>`)
        clearTimeout(timer)
        if (error || !got) reject(new Error(`Google sign-in: ${error}`)); else resolve(got)
      })
      void shell.openExternal(authUrl(client, redirect, challenge, state))
    })
    const tokens = await exchangeCode(client, code, verifier, redirect)
    if (!tokens.refresh) throw new Error('Google gave no refresh token (sign in again and accept the permission)')
    await store.save(tokens.refresh)
  } finally { server.close() }
}
