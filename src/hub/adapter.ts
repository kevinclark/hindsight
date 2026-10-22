/**
 * Where a library's files live. Hindsight keeps the library in a local folder and shares it through the team's store
 * (Google Drive first); each store is one StorageAdapter, so a synced-folder or S3 adapter can follow without touching
 * the ingest or the library.
 *
 * The interface has no delete and no overwrite: nothing built on it can remove a log. Paths are relative to the
 * library root, with "/" between parts: `logs/<school year>/<date>/<name>` and `manifests/<machine id>.jsonl`.
 */

export interface FileInfo {
  path: string
  size: number
  /** Milliseconds since 1970 as the store has it (for Drive, the upload time unless the uploader set it); null if unknown. */
  modifiedTime: number | null
  /** Checksums, when the store reports them (Drive: `sha256Checksum` "if available", `md5Checksum`). */
  sha256?: string
  md5?: string
}

/** Bytes to be written, read by range so a 672 MB log is never held whole. `end` is exclusive. */
export interface ByteSource {
  size: number
  read(start: number, end: number): Promise<Uint8Array>
}

export interface WriteOptions {
  /** The log's sha-256. A store that can check before it commits does (the local folder); one that can't (Drive) checks the answer and throws ChecksumMismatch. */
  sha256?: string
  /** Called with the bytes sent so far. */
  onProgress?: (sent: number, total: number) => void
}

export interface StorageAdapter {
  /** Every file under `prefix`, however deep. */
  list(prefix: string): Promise<FileInfo[]>
  stat(path: string): Promise<FileInfo | null>
  read(path: string, start: number, end: number): Promise<Uint8Array>
  /**
   * Create a file that does not exist. Throws AlreadyExists if it does. If it fails part way, nothing is left at `path`
   * (a local temp file is removed, a Drive upload session is abandoned).
   */
  writeNew(path: string, from: ByteSource, options?: WriteOptions): Promise<FileInfo>
  /**
   * Make this writer's own manifest `content`. The file already there must be a prefix of `content` (this writer's
   * earlier appends); if it holds anything else, someone else wrote to it and nothing is changed (ManifestConflict).
   */
  appendManifest(path: string, content: string): Promise<void>
}

export class AlreadyExists extends Error {
  constructor(public readonly path: string) { super(`${path} already exists`) }
}
export class ManifestConflict extends Error {
  constructor(public readonly path: string) { super(`${path} holds records this copy lacks: not changed`) }
}
export class ChecksumMismatch extends Error {
  constructor(public readonly path: string, public readonly want: string, public readonly got: string) { super(`${path}: sha-256 is ${got}, expected ${want}`) }
}
/** The store refused for a reason signing in again fixes (Drive `invalid_grant`). */
export class SignInAgain extends Error {
  constructor(message = 'Sign in to Google again') { super(message) }
}

/** A path inside the library: no leading "/", no "..", no empty parts, no backslash or control characters. */
export function checkPath(path: string): string {
  const parts = path.split('/')
  if (path === '' || parts.some((p) => p === '' || p === '.' || p === '..') || /[\\\x00-\x1f]/.test(path)) throw new Error(`not a library path: ${JSON.stringify(path)}`)
  return path
}

export function isManifestPath(path: string): boolean {
  return /^manifests\/[A-Za-z0-9_-]+\.jsonl$/.test(path)
}

/** Read a whole (small) file as text, in chunks. */
export async function readText(store: StorageAdapter, path: string): Promise<string | null> {
  const info = await store.stat(path)
  if (!info) return null
  const bytes = info.size === 0 ? new Uint8Array(0) : await store.read(path, 0, info.size)
  return new TextDecoder().decode(bytes)
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }
}

/** The check every adapter's appendManifest makes: what is there already must be the start of what is to be written. */
export function extendsManifest(existing: string, content: string): boolean {
  return content.startsWith(existing)
}
