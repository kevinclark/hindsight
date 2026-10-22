import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DriveAdapter, DriveError } from '../src/hub/drive-adapter.ts'
import { AlreadyExists, ChecksumMismatch, SignInAgain, bytesSource, readText } from '../src/hub/adapter.ts'
import { SCOPE, authUrl, exchangeCode, newPkce, refreshAccess, tokenSource } from '../src/hub/oauth.ts'
import { adapterContract } from './helpers/adapter-contract.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const noSleep = async () => {}
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 29 + 3) & 255)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

function setup(token = async () => 'good') {
  const drive = new FakeDrive()
  const store = new DriveAdapter({ rootId: 'root', token, fetch: drive.fetch, sleep: noSleep })
  return { drive, store }
}

adapterContract('Google Drive (fake API)', async () => {
  const { drive, store } = setup()
  return { store, failNextUploadAfter: (n) => { drive.failNextUploadAfter = n } }
})

describe('Drive adapter', () => {
  it('lists across pages and folders, and finds a file by name', async () => {
    const { drive, store } = setup()
    for (const n of ['a', 'b', 'c', 'd', 'e']) await store.writeNew(`logs/y/d/${n}.wpilog`, bytesSource(pattern(10)))
    expect((await store.list('logs')).map((f) => f.path)).toEqual(['a', 'b', 'c', 'd', 'e'].map((n) => `logs/y/d/${n}.wpilog`))
    expect(drive.log.filter((l) => l === 'GET /drive/v3/files').length).toBeGreaterThan(5)
  })

  it('puts a big file up in chunks of 8 MiB, each with its byte range, and keeps the original modified time', async () => {
    const { drive, store } = setup()
    const bytes = pattern(17 * (1 << 20) + 5)
    await store.writeNew('logs/y/d/big.wpilog', bytesSource(bytes), { sha256: sha(bytes), modifiedTime: Date.UTC(2026, 9, 17, 20) })
    expect(drive.log.filter((l) => l.startsWith('PUT /session')).length).toBe(3)
    const node = drive.at('logs/y/d/big.wpilog')!
    expect(node.modifiedTime).toBe('2026-10-17T20:00:00.000Z')
    expect(sha(node.bytes!)).toBe(sha(bytes))
  })

  it('resumes after one dropped chunk without starting the file again', async () => {
    const { drive, store } = setup()
    const bytes = pattern(9 * (1 << 20))
    drive.dropNextChunk = true
    await store.writeNew('logs/y/d/a.wpilog', bytesSource(bytes), { sha256: sha(bytes) })
    expect(sha(drive.at('logs/y/d/a.wpilog')!.bytes!)).toBe(sha(bytes))
    expect(drive.log.filter((l) => l === 'POST /upload/drive/v3/files?resumable').length).toBe(1)
  })

  it('a permanently failing connection fails the write, leaves no file and no record of one', async () => {
    const { drive, store } = setup()
    const bytes = pattern(20 * (1 << 20))
    drive.failNextUploadAfter = 8 << 20
    await expect(store.writeNew('logs/y/d/a.wpilog', bytesSource(bytes))).rejects.toThrow()
    expect(drive.at('logs/y/d/a.wpilog')).toBeUndefined()
    expect(await store.stat('logs/y/d/a.wpilog')).toBeNull()
  })

  it('reports a corrupted upload (checksums differ), which Drive cannot undo and the adapter cannot delete', async () => {
    const { drive, store } = setup()
    drive.corruptNextUpload = true
    await expect(store.writeNew('logs/y/d/a.wpilog', bytesSource(pattern(100)), { sha256: sha(pattern(100)) })).rejects.toBeInstanceOf(ChecksumMismatch)
  })

  it('works when Drive reports no sha-256 (md5 only), and uploads an empty file', async () => {
    const { drive, store } = setup()
    drive.withoutSha256 = true
    const info = await store.writeNew('logs/y/d/a.wpilog', bytesSource(pattern(50)))
    expect(info.sha256).toBeUndefined()
    expect(info.md5).toBe(createHash('md5').update(pattern(50)).digest('hex'))
    expect((await store.writeNew('logs/y/d/empty.wpilog', bytesSource(new Uint8Array(0)))).size).toBe(0)
  })

  it('refuses to write over a log that is there', async () => {
    const { store } = setup()
    await store.writeNew('logs/y/d/a.wpilog', bytesSource(pattern(5)))
    await expect(store.writeNew('logs/y/d/a.wpilog', bytesSource(pattern(6)))).rejects.toBeInstanceOf(AlreadyExists)
  })

  it('asks for a fresh token once on a 401, then says sign in again', async () => {
    const asked: boolean[] = []
    const { drive, store } = setup(async () => 'stale')
    const refreshing = new DriveAdapter({ rootId: 'root', token: async (refresh) => { asked.push(!!refresh); return refresh ? 'good' : 'stale' }, fetch: drive.fetch, sleep: noSleep })
    expect(await refreshing.list('logs')).toEqual([])
    expect(asked.slice(0, 2)).toEqual([false, true]) // the first answer was refused, so the next asks for a new token
    await expect(store.list('logs')).rejects.toBeInstanceOf(SignInAgain)
  })

  it('retries 5xx and 429, but not a 403', async () => {
    const drive = new FakeDrive()
    let n = 0
    const flaky: typeof fetch = async (input, init) => (++n <= 2 ? new Response('busy', { status: n === 1 ? 503 : 429 }) : drive.fetch(input, init))
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: flaky, sleep: noSleep })
    expect(await store.list('logs')).toEqual([])
    const denied = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: async () => new Response('no', { status: 403 }), sleep: noSleep })
    await expect(denied.list('logs')).rejects.toBeInstanceOf(DriveError)
  })

  it('copies a file inside Drive (no upload) into the layout, and reads folder choices for the picker', async () => {
    const { drive, store } = setup()
    const elsewhere = drive.addFolder('root', 'other')
    const id = drive.addFile(elsewhere, 'x.wpilog', pattern(1000))
    const info = await store.copyInto(id, 'logs/y/d/x.wpilog')
    expect(info.size).toBe(1000)
    expect(store.calls.upload).toBe(0)
    expect(store.calls.copy).toBe(1)
    expect((await store.folderChoices('roots')).map((f) => f.name)).toEqual(['My Drive', 'Shared one'])
    expect((await store.folderChoices('root')).map((f) => f.name)).toEqual(['logs', 'other'])
    expect(await store.describeFolder(elsewhere)).toEqual({ id: elsewhere, name: 'other' })
    expect(await store.describeFolder(id)).toBeNull()
  })

  it('updates only its own manifest, and refuses one that changed under it', async () => {
    const { drive, store } = setup()
    await store.appendManifest('manifests/m1.jsonl', '{"a":1}\n')
    await store.appendManifest('manifests/m1.jsonl', '{"a":1}\n{"a":2}\n')
    drive.nodes.get(drive.at('manifests/m1.jsonl')!.id)!.bytes = new TextEncoder().encode('{"a":1}\n{"z":0}\n')
    await expect(store.appendManifest('manifests/m1.jsonl', '{"a":1}\n{"a":2}\n{"a":3}\n')).rejects.toThrow(/lacks/)
    expect(await readText(store, 'manifests/m1.jsonl')).toBe('{"a":1}\n{"z":0}\n')
  })
})

describe('Google sign-in', () => {
  const client = { id: 'client-id', secret: 'client-secret' }
  const tokenFetch = (answers: object[], seen: URLSearchParams[] = []): typeof fetch => async (_u, init) => {
    seen.push(new URLSearchParams(String(init?.body)))
    const a = answers.shift()!
    return new Response(JSON.stringify(a), { status: 'error' in a ? 400 : 200 })
  }

  it('builds a PKCE authorisation URL with the drive scope, offline access and a loopback redirect', () => {
    const { verifier, challenge } = newPkce()
    const url = new URL(authUrl(client, 'http://127.0.0.1:5555', challenge, 'st'))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'client-id', redirect_uri: 'http://127.0.0.1:5555', scope: SCOPE, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', state: 'st' })
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('exchanges the code with the verifier and keeps the refresh token', async () => {
    const seen: URLSearchParams[] = []
    const t = await exchangeCode(client, 'the-code', 'ver', 'http://127.0.0.1:5555', 1000, tokenFetch([{ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }], seen))
    expect(t).toEqual({ access: 'a1', refresh: 'r1', expiresAt: 1000 + 3600_000 })
    expect(Object.fromEntries(seen[0])).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: 'ver', client_secret: 'client-secret' })
  })

  it('renews the access token from the stored refresh token, and asks to sign in again on invalid_grant (clearing it)', async () => {
    let stored: string | null = 'r1'
    const store = { load: async () => stored, save: async (r: string) => { stored = r }, clear: async () => { stored = null } }
    let now = 0
    const token = tokenSource(client, store, tokenFetch([{ access_token: 'a1', expires_in: 3600 }, { access_token: 'a2', expires_in: 3600 }, { error: 'invalid_grant' }]), () => now)
    expect(await token()).toBe('a1')
    expect(await token()).toBe('a1') // still valid
    now = 3600_000
    expect(await token()).toBe('a2')
    expect(await token(true).catch((e) => e)).toBeInstanceOf(SignInAgain)
    expect(stored).toBeNull()
    expect(await token().catch((e) => e)).toBeInstanceOf(SignInAgain)
  })

  it('refreshAccess keeps the old refresh token when Google sends no new one', async () => {
    expect((await refreshAccess(client, 'r1', 0, tokenFetch([{ access_token: 'a', expires_in: 10 }]))).refresh).toBe('r1')
  })
})
