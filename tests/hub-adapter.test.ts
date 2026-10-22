import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalFolderAdapter } from '../src/hub/local-adapter.ts'
import { bytesSource, type ByteSource } from '../src/hub/adapter.ts'
import { adapterContract } from './helpers/adapter-contract.ts'

adapterContract('in-memory', async () => {
  const store = new MemoryAdapter()
  return { store, failNextUploadAfter: (n) => { store.failUploadAfter = n } }
})

adapterContract('local-folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hindsight-adapter-'))
  const store = new LocalFolderAdapter(root)
  // A source that throws once n bytes have been handed over: a dropped connection.
  let failAt: number | null = null
  const original = store.writeNew.bind(store)
  store.writeNew = (path, from, options) => {
    const limit = failAt
    failAt = null
    const wrapped: ByteSource = limit === null ? from : { size: from.size, read: async (a, b) => { if (b > limit) throw new Error('connection dropped'); return from.read(a, b) } }
    return original(path, wrapped, options)
  }
  return { store, failNextUploadAfter: (n) => { failAt = n }, cleanup: () => rm(root, { recursive: true, force: true }) }
})

describe('local-folder adapter', () => {
  it('leaves no .part file after a failed or mismatched write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hindsight-adapter-'))
    const store = new LocalFolderAdapter(root)
    await expect(store.writeNew('logs/u/x.wpilog', bytesSource(new Uint8Array(10)), { sha256: 'ff' })).rejects.toThrow()
    expect(await readdir(join(root, 'logs', 'u'))).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})
