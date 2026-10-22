/** A StorageAdapter over a folder on this machine: the local library, and later any synced folder (Drive for desktop, a NAS share). */
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat as fsStat, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AlreadyExists, ChecksumMismatch, ManifestConflict, checkPath, extendsManifest, isManifestPath, type ByteSource, type FileInfo, type StorageAdapter, type WriteOptions } from './adapter.ts'

const CHUNK = 4 << 20
/** Marks a file still being written; never listed, never read as a library file. */
export const PART_SUFFIX = '.part'

export class LocalFolderAdapter implements StorageAdapter {
  readonly root: string
  constructor(root: string) { this.root = root }

  /** Where a library path is on disk. */
  at(path: string): string { return join(this.root, ...checkPath(path).split('/')) }

  async list(prefix: string): Promise<FileInfo[]> {
    const out: FileInfo[] = []
    const walk = async (rel: string) => {
      let entries
      try { entries = await readdir(this.at(rel), { withFileTypes: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return; throw e }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name.endsWith(PART_SUFFIX)) continue
        if (e.isDirectory()) await walk(`${rel}/${e.name}`)
        else if (e.isFile()) out.push(await this.statFile(`${rel}/${e.name}`))
      }
    }
    const single = await this.stat(prefix)
    if (single) return [single]
    await walk(prefix)
    return out
  }

  async stat(path: string): Promise<FileInfo | null> {
    try {
      return (await fsStat(this.at(path))).isFile() ? await this.statFile(path) : null
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }

  /** Size and time only: hashing a library on every list would read all of it. */
  private async statFile(path: string): Promise<FileInfo> {
    const s = await fsStat(this.at(path))
    return { path, size: s.size, modifiedTime: Math.round(s.mtimeMs) }
  }

  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const handle = await open(this.at(path), 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, end - start))
      const { bytesRead } = await handle.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead)
    } finally { await handle.close() }
  }

  async writeNew(path: string, from: ByteSource, options: WriteOptions = {}): Promise<FileInfo> {
    const target = this.at(path)
    if (await this.stat(path)) throw new AlreadyExists(path)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${randomBytes(4).toString('hex')}${PART_SUFFIX}`
    const handle = await open(temp, 'wx')
    try {
      const hash = createHash('sha256')
      for (let at = 0; at < from.size; at += CHUNK) {
        const chunk = await from.read(at, Math.min(from.size, at + CHUNK))
        hash.update(chunk)
        await handle.write(chunk)
        options.onProgress?.(Math.min(from.size, at + CHUNK), from.size)
      }
      await handle.close()
      const got = hash.digest('hex')
      if (options.sha256 && got !== options.sha256) throw new ChecksumMismatch(path, options.sha256, got)
      // A file made since we looked is not overwritten: link-then-rename is not portable, so check once more.
      if (await this.stat(path)) throw new AlreadyExists(path)
      await rename(temp, target)
    } catch (e) {
      await handle.close().catch(() => {})
      await rm(temp, { force: true })
      throw e
    }
    return this.statFile(path)
  }

  async appendManifest(path: string, content: string): Promise<void> {
    if (!isManifestPath(checkPath(path))) throw new Error(`${path} is not a manifest path`)
    const existing = await readFile(this.at(path), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e })
    if (existing !== null && !extendsManifest(existing, content)) throw new ManifestConflict(path)
    await mkdir(dirname(this.at(path)), { recursive: true })
    const temp = `${this.at(path)}.${randomBytes(4).toString('hex')}${PART_SUFFIX}`
    await writeFile(temp, content)
    await rename(temp, this.at(path))
  }
}

/** A file on this machine as bytes to write, read by range. */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r')
  const { size } = await handle.stat()
  return {
    size,
    async read(start, end) {
      const buf = Buffer.alloc(Math.max(0, end - start))
      const { bytesRead } = await handle.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead)
    },
    close: () => handle.close(),
  }
}

/** sha-256 and md5 of a file, streamed (a practice log is 672 MB). */
export function hashFile(path: string): Promise<{ sha256: string; md5: string }> {
  return new Promise((resolve, reject) => {
    const sha = createHash('sha256')
    const md5 = createHash('md5')
    createReadStream(path).on('data', (d) => { sha.update(d); md5.update(d) }).on('error', reject)
      .on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex') }))
  })
}
