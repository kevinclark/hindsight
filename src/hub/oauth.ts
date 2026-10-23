/**
 * Google sign-in for an installed app: the system browser, a loopback redirect and PKCE (RFC 7636, RFC 8252). The app
 * never sees a password. Pure functions over an injected fetch; the loopback server and token storage are in
 * electron/google-auth.ts. A Desktop client's secret is not secret (Google says so): it is injected at build time and
 * never committed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { SignInAgain } from './adapter.ts'

export const SCOPE = 'https://www.googleapis.com/auth/drive'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface Client { id: string; secret: string }

export interface Tokens { access: string; refresh: string | null; expiresAt: number }

const b64url = (b: Buffer) => b.toString('base64url')

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authUrl(client: Client, redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: client.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256',
    state, access_type: 'offline', prompt: 'consent',
  })
  return `${AUTH_URL}?${q}`
}

async function tokenRequest(body: Record<string, string>, client: Client, now: number, doFetch: typeof fetch): Promise<Tokens> {
  const res = await doFetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...body }) })
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  // A refresh token Google no longer honours (revoked, expired in Testing, password change): sign in again, don't retry.
  if (json.error === 'invalid_grant') throw new SignInAgain('Google no longer accepts this sign-in. Sign in again.')
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`)
  return { access: json.access_token, refresh: json.refresh_token ?? null, expiresAt: now + (json.expires_in ?? 3600) * 1000 }
}

export function exchangeCode(client: Client, code: string, verifier: string, redirectUri: string, now = Date.now(), doFetch: typeof fetch = fetch): Promise<Tokens> {
  return tokenRequest({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }, client, now, doFetch)
}

export async function refreshAccess(client: Client, refresh: string, now = Date.now(), doFetch: typeof fetch = fetch): Promise<Tokens> {
  const t = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' }, client, now, doFetch)
  return { ...t, refresh: t.refresh ?? refresh }
}

/** An access token that renews itself: what DriveAdapter's `token` needs. `store` keeps the refresh token between runs. */
export function tokenSource(client: Client, store: { load(): Promise<string | null>; save(refresh: string): Promise<void>; clear(): Promise<void> }, doFetch: typeof fetch = fetch, now: () => number = Date.now) {
  let current: Tokens | null = null
  return async (forceRefresh = false): Promise<string> => {
    if (current && !forceRefresh && current.expiresAt - now() > 60_000) return current.access
    const refresh = current?.refresh ?? (await store.load())
    if (!refresh) throw new SignInAgain('Sign in to Google first.')
    try {
      current = await refreshAccess(client, refresh, now(), doFetch)
    } catch (e) {
      if (e instanceof SignInAgain) { current = null; await store.clear() }
      throw e
    }
    return current.access
  }
}
