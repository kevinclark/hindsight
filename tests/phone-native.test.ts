// The phone's network: requests to Google, The Blue Alliance and Nexus go through the app's own native HTTP (a WebView page
// at capacitor://localhost is refused by CORS on Google's token endpoint, and Drive's answers must arrive byte for byte for
// the sha-256 check), everything else stays with the WebView's fetch.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NATIVE_HOSTS, fromBase64, goesNative, nativeFetch, routedFetch, toBase64 } from '../src/phone/native-fetch.ts'
import type { NativeHttp, NativeHttpRequest } from '../src/phone/native.ts'
import { DriveReader } from '../src/hub/drive-read.ts'
import { memoryCache, readAppendOnly } from '../src/hub/phone-cache.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

/** The native side as the Swift plugin behaves: bytes in and out as base64, whatever the content type. Backed by a fetch. */
function fakeNative(serve: typeof fetch, seen: NativeHttpRequest[] = []): NativeHttp {
  return {
    async http(req) {
      seen.push(req)
      const res = await serve(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: unb64(req.body) } : {}) })
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      return { status: res.status, headers, body: b64(new Uint8Array(await res.arrayBuffer())) }
    },
  }
}

describe('nativeFetch', () => {
  it('returns every byte value unchanged, and a JSON answer as its exact text (no parse-and-reserialize)', async () => {
    const all = Uint8Array.from({ length: 256 * 3 }, (_, i) => (i * 7) & 255)
    const jsonText = '{ "b":1,  "a" : [2.50, "\\u00e9"] }\n'
    const f = nativeFetch(fakeNative(async (url) => String(url).endsWith('/bin')
      ? new Response(all as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(jsonText, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8' } })))
    expect(new Uint8Array(await (await f('https://www.googleapis.com/bin')).arrayBuffer())).toEqual(all)
    const res = await f('https://www.googleapis.com/json')
    expect(res.headers.get('content-type')).toBe('application/json; charset=UTF-8')
    expect(await res.text()).toBe(jsonText)
  })

  it('passes method, headers (a Range, a key) and a form body through, and gives back the status', async () => {
    const seen: NativeHttpRequest[] = []
    const f = nativeFetch(fakeNative(async (_u, init) => new Response(init?.body ? 'ok' : 'part', { status: init?.body ? 200 : 206 }), seen))
    const part = await f('https://www.googleapis.com/drive/v3/files/x?alt=media', { headers: new Headers({ Range: 'bytes=5-9', Authorization: 'Bearer t' }) })
    expect(part.status).toBe(206)
    expect(seen[0]).toMatchObject({ url: 'https://www.googleapis.com/drive/v3/files/x?alt=media', method: 'GET' })
    expect(seen[0].headers).toMatchObject({ range: 'bytes=5-9', authorization: 'Bearer t' })
    expect(seen[0].body).toBeUndefined()
    await f('https://oauth2.googleapis.com/token', { method: 'post', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'a b', grant_type: 'authorization_code' }) })
    expect(seen[1].method).toBe('POST')
    expect(seen[1].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new TextDecoder().decode(unb64(seen[1].body!))).toBe('code=a+b&grant_type=authorization_code')
  })

  it('answers a status with no body (204, 304) with an empty body, and a native failure as a TypeError like fetch', async () => {
    const f = nativeFetch({ http: async () => ({ status: 204, headers: {}, body: '' }) })
    expect((await f('https://frc.nexus/api/v1/x')).status).toBe(204)
    const down = nativeFetch({ http: async () => { throw new Error('The Internet connection appears to be offline.') } })
    await expect(down('https://frc.nexus/api/v1/x')).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses a URL that is not https to an allowed host before asking the native side', async () => {
    const seen: NativeHttpRequest[] = []
    const f = nativeFetch(fakeNative(async () => new Response('x'), seen))
    for (const u of ['http://www.googleapis.com/drive/v3/files', 'https://evil.example/x', 'https://www.googleapis.com.evil.example/x']) await expect(f(u)).rejects.toThrow(/not sent/)
    expect(seen).toEqual([])
  })
})

describe('native bridge details', () => {
  it('the Swift side allows exactly NATIVE_HOSTS', () => {
    const swift = readFileSync('ios/App/App/HindsightNativePlugin.swift', 'utf8')
    const set = /static let hosts: Set<String> = \[([^\]]*)\]/.exec(swift)?.[1] ?? ''
    expect([...set.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([...NATIVE_HOSTS].sort())
  })

  it('base64 round-trips a body larger than one encoding chunk (32 KiB)', () => {
    const big = Uint8Array.from({ length: 0x8000 * 3 + 17 }, (_, i) => (i * 131 + 7) & 255)
    expect(toBase64(big)).toBe(Buffer.from(big).toString('base64'))
    expect(fromBase64(toBase64(big))).toEqual(big)
  })

  it('takes a Request with a body, as fetch does', async () => {
    const seen: NativeHttpRequest[] = []
    const f = nativeFetch(fakeNative(async () => new Response('ok'), seen))
    await f(new Request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a=1' }))
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { 'content-type': 'text/plain' } })
    expect(new TextDecoder().decode(unb64(seen[0].body!))).toBe('a=1')
  })
})

describe('routedFetch', () => {
  it('sends Google, The Blue Alliance and Nexus natively, everything else to the WebView', async () => {
    expect(NATIVE_HOSTS).toEqual(['www.googleapis.com', 'oauth2.googleapis.com', 'www.thebluealliance.com', 'frc.nexus'])
    for (const u of ['https://www.googleapis.com/drive/v3/files', 'https://oauth2.googleapis.com/token', 'https://www.thebluealliance.com/api/v3/status', 'https://frc.nexus/api/v1/events']) expect(goesNative(u)).toBe(true)
    for (const u of ['capacitor://localhost/index.html', 'data:application/wasm;base64,AA==', 'http://www.googleapis.com/x', 'https://accounts.google.com/o/oauth2/v2/auth', '/relative']) expect(goesNative(u)).toBe(false)
    const went: string[] = []
    const name = (u: RequestInfo | URL) => (u instanceof Request ? u.url : String(u))
    const f = routedFetch(async (u) => { went.push(`web ${name(u)}`); return new Response('') }, async (u) => { went.push(`native ${name(u)}`); return new Response('') })
    await f('https://frc.nexus/api/v1/x')
    await f('data:,x')
    await f(new Request('https://www.thebluealliance.com/api/v3/status'))
    expect(went).toEqual(['native https://frc.nexus/api/v1/x', 'web data:,x', 'native https://www.thebluealliance.com/api/v3/status'])
  })
})

describe('Drive through the native bridge', () => {
  // The brief's first test: binary range reads and the sha-256 check through native HTTP, not only through Node's fetch.
  it('reads a grown append-only file as a tail and the joined bytes pass the sha-256 check', async () => {
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'events')
    const head = '{"a":"é"}\n'
    const id = drive.addFile(folder, '2026test--laptop-a.jsonl', head)
    const seen: NativeHttpRequest[] = []
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: nativeFetch(fakeNative(drive.fetch, seen)), sleep: async () => {} })
    const cache = memoryCache()
    const path = 'events/2026test--laptop-a.jsonl'
    expect((await readAppendOnly(reader, (await reader.stat(path))!, cache)).how).toBe('whole')
    const tail = '{"b":"\u{1F916}"}\n'
    drive.nodes.get(id)!.bytes = new TextEncoder().encode(head + tail)
    const info = (await reader.stat(path))!
    expect(info.sha256).toBe(createHash('sha256').update(head + tail).digest('hex'))
    const got = await readAppendOnly(reader, info, cache)
    expect(got).toEqual({ text: head + tail, how: 'tail' })
    const headBytes = new TextEncoder().encode(head).length
    expect(seen.at(-1)!.headers.range).toBe(`bytes=${headBytes}-${info.size - 1}`)
  })
})
