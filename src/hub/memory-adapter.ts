/**
 * A StorageAdapter that keeps everything in memory: the fake the tests use, and the reference for what any store must
 * do. `failUploadAfter` makes the next writeNew fail after that many bytes, as a dropped connection does mid-file.
 */
import { AlreadyExists, ChecksumMismatch, ManifestConflict, checkPath, extendsManifest, isOwnAppendPath, type ByteSource, type FileInfo, type StorageAdapter, type WriteOptions } from './adapter.ts'
import { createHash } from 'node:crypto'

const CHUNK = 1 << 20

export class MemoryAdapter implements StorageAdapter {
  readonly files = new Map<string, { bytes: Uint8Array; modifiedTime: number }>()
  /** Fail the next writeNew after this many bytes have been read from its source. */
  failUploadAfter: number | null = null
  /** Every writeNew and appendManifest call, in order, for "a re-run writes nothing". */
  writes: string[] = []
  private clock = 1_700_000_000_000

  async list(prefix: string): Promise<FileInfo[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || p === prefix).sort().map((p) => this.info(p))
  }

  async stat(path: string): Promise<FileInfo | null> {
    return this.files.has(checkPath(path)) ? this.info(path) : null
  }

  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const f = this.files.get(checkPath(path))
    if (!f) throw new Error(`${path} not found`)
    return f.bytes.slice(start, Math.min(end, f.bytes.length))
  }

  async writeNew(path: string, from: ByteSource, options: WriteOptions = {}): Promise<FileInfo> {
    checkPath(path)
    if (this.files.has(path)) throw new AlreadyExists(path)
    this.writes.push(path)
    const out = new Uint8Array(from.size)
    const fail = this.failUploadAfter
    this.failUploadAfter = null
    for (let at = 0; at < from.size; at += CHUNK) {
      if (fail !== null && at >= fail) throw new Error('connection dropped')
      out.set(await from.read(at, Math.min(from.size, at + CHUNK)), at)
      options.onProgress?.(Math.min(from.size, at + CHUNK), from.size)
    }
    if (options.sha256) {
      const got = createHash('sha256').update(out).digest('hex')
      if (got !== options.sha256) throw new ChecksumMismatch(path, options.sha256, got)
    }
    this.files.set(path, { bytes: out, modifiedTime: this.clock++ })
    return this.info(path)
  }

  async appendManifest(path: string, content: string): Promise<void> {
    if (!isOwnAppendPath(checkPath(path))) throw new Error(`${path} is not a file this machine appends to`)
    const existing = this.files.get(path)
    if (existing && !extendsManifest(new TextDecoder().decode(existing.bytes), content)) throw new ManifestConflict(path)
    this.writes.push(path)
    this.files.set(path, { bytes: new TextEncoder().encode(content), modifiedTime: this.clock++ })
  }

  /** Put a file there as if another machine had (tests only). */
  put(path: string, content: Uint8Array | string): void {
    this.files.set(path, { bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content, modifiedTime: this.clock++ })
  }

  private info(path: string): FileInfo {
    const f = this.files.get(path)!
    return {
      path, size: f.bytes.length, modifiedTime: f.modifiedTime,
      sha256: createHash('sha256').update(f.bytes).digest('hex'), md5: createHash('md5').update(f.bytes).digest('hex'),
    }
  }
}
