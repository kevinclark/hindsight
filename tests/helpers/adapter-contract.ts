/** What every StorageAdapter must do, run against each one (tests/hub-adapter.test.ts, tests/hub-drive.test.ts). */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { AlreadyExists, ChecksumMismatch, ManifestConflict, bytesSource, readText, type ByteSource, type StorageAdapter } from '../../src/hub/adapter.ts'

export interface Fixture {
  store: StorageAdapter
  /** Make the next writeNew fail after about this many bytes. */
  failNextUploadAfter(bytes: number): void
  cleanup?(): Promise<void>
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255)

/** Bytes that count how many ranges were asked for. */
function counting(bytes: Uint8Array): ByteSource & { reads: number } {
  const s = { size: bytes.length, reads: 0, read: async (a: number, b: number) => { s.reads++; return bytes.subarray(a, b) } }
  return s
}

export function adapterContract(name: string, make: () => Promise<Fixture>) {
  describe(`${name} adapter`, () => {
    it('writes a new file, lists it under its folder and reads a range back', async () => {
      const f = await make()
      const bytes = pattern(5000)
      const info = await f.store.writeNew('logs/2026-2027/2026-10-17/a.wpilog', bytesSource(bytes), { sha256: sha(bytes) })
      expect(info).toMatchObject({ path: 'logs/2026-2027/2026-10-17/a.wpilog', size: 5000 })
      expect((await f.store.list('logs')).map((x) => x.path)).toEqual(['logs/2026-2027/2026-10-17/a.wpilog'])
      expect((await f.store.list('logs/2026-2027')).length).toBe(1)
      expect((await f.store.list('manifests')).length).toBe(0)
      expect(Buffer.from(await f.store.read('logs/2026-2027/2026-10-17/a.wpilog', 100, 150))).toEqual(Buffer.from(bytes.subarray(100, 150)))
      expect((await f.store.stat('logs/2026-2027/2026-10-17/a.wpilog'))?.size).toBe(5000)
      expect(await f.store.stat('logs/none')).toBeNull()
      await f.cleanup?.()
    })

    it('has no way to overwrite: a second write to the same path throws and changes nothing', async () => {
      const f = await make()
      await f.store.writeNew('logs/u/x.wpilog', bytesSource(pattern(10)))
      await expect(f.store.writeNew('logs/u/x.wpilog', bytesSource(pattern(20)))).rejects.toBeInstanceOf(AlreadyExists)
      expect((await f.store.stat('logs/u/x.wpilog'))?.size).toBe(10)
      expect('delete' in f.store || 'remove' in f.store || 'overwrite' in f.store).toBe(false)
      await f.cleanup?.()
    })

    it('leaves nothing behind when an upload fails mid-file, and the same path can be written afterwards', async () => {
      const f = await make()
      const bytes = pattern(3 * (1 << 20) + 17)
      f.failNextUploadAfter(1 << 20)
      await expect(f.store.writeNew('logs/u/big.wpilog', bytesSource(bytes), { sha256: sha(bytes) })).rejects.toThrow()
      expect(await f.store.stat('logs/u/big.wpilog')).toBeNull()
      expect(await f.store.list('logs')).toEqual([])
      const info = await f.store.writeNew('logs/u/big.wpilog', bytesSource(bytes), { sha256: sha(bytes) })
      expect(info.size).toBe(bytes.length)
      await f.cleanup?.()
    })

    it('refuses bytes that do not match the expected sha-256', async () => {
      const f = await make()
      const bytes = pattern(100)
      await expect(f.store.writeNew('logs/u/bad.wpilog', bytesSource(bytes), { sha256: sha(pattern(101)) })).rejects.toBeInstanceOf(ChecksumMismatch)
      // A store that can only check after committing (Drive) still reports it; the local ones leave nothing.
      await f.cleanup?.()
    })

    it('reports progress up to the full size', async () => {
      const f = await make()
      const bytes = pattern(2 * (1 << 20) + 5)
      const seen: number[] = []
      await f.store.writeNew('logs/u/p.wpilog', counting(bytes), { onProgress: (sent) => seen.push(sent) })
      expect(seen.at(-1)).toBe(bytes.length)
      expect(seen).toEqual([...seen].sort((a, b) => a - b))
      await f.cleanup?.()
    })

    it('appends to its own manifest, and refuses when the file holds records the writer lacks', async () => {
      const f = await make()
      await f.store.appendManifest('manifests/m1.jsonl', '{"a":1}\n')
      await f.store.appendManifest('manifests/m1.jsonl', '{"a":1}\n{"a":2}\n')
      expect(await readText(f.store, 'manifests/m1.jsonl')).toBe('{"a":1}\n{"a":2}\n')
      // Someone else wrote a third record: a writer that never saw it must not replace it.
      await expect(f.store.appendManifest('manifests/m1.jsonl', '{"a":1}\n{"a":9}\n')).rejects.toBeInstanceOf(ManifestConflict)
      expect(await readText(f.store, 'manifests/m1.jsonl')).toBe('{"a":1}\n{"a":2}\n')
      // Appending what is already there is allowed (a re-run).
      await f.store.appendManifest('manifests/m1.jsonl', '{"a":1}\n{"a":2}\n')
      await expect(f.store.appendManifest('logs/x.jsonl', 'x')).rejects.toThrow()
      await f.cleanup?.()
    })

    it('rejects paths that leave the library', async () => {
      const f = await make()
      for (const bad of ['../x', '/etc/passwd', 'logs//x', 'logs/../../x', 'a\\b']) {
        await expect(f.store.writeNew(bad, bytesSource(pattern(1)))).rejects.toThrow()
      }
      await f.cleanup?.()
    })
  })
}
