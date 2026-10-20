/**
 * Reads a file as it was at one commit, straight from a robot-code folder's .git: loose objects and pack files (pack
 * index v2, with OFS_DELTA and REF_DELTA objects), inflated with the platform's DecompressionStream (browsers and Node
 * both have it). No git program, no dependency, read-only.
 *
 * It reads only what it needs: a pack index's fan-out table, one bucket of its names and its offset table, and the
 * pack bytes of the objects it opens (a commit, the trees on the way to a file, the file, and their delta bases).
 */

/** The files of a .git folder. The browser (a chosen folder) and Node (scripts) each supply one. */
export interface GitDir {
  /** The bytes of a file, by its path inside .git ("objects/pack/x.idx"): all of it, or [start, end). Null if missing. */
  read(path: string, start?: number, end?: number): Promise<Uint8Array | null>
  /** A file's size in bytes, or null if missing. */
  size(path: string): Promise<number | null>
  /** The names in a folder inside .git (empty if there is no such folder). */
  list(path: string): Promise<string[]>
}

/** Why a commit or file can't be read: shown to people as the reason a comparison couldn't be made. */
export class GitUnreadable extends Error {}

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag'
export interface GitObject { kind: ObjectKind; data: Uint8Array }
export interface TreeEntry { mode: string; name: string; sha: string }

const KINDS: Record<number, ObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }
const OFS_DELTA = 6
const REF_DELTA = 7
/** Objects kept in memory once inflated (trees and delta bases are read again and again). */
const KEEP_OBJECTS = 256

export class GitRepo {
  private packs: Promise<Pack[]> | null = null
  private kept = new Map<string, GitObject>()
  readonly dir: GitDir

  constructor(dir: GitDir) {
    this.dir = dir
  }

  /** The full commit hash a hash or prefix (7+ hex characters) names. Throws GitUnreadable when it can't. */
  async resolve(prefix: string): Promise<string> {
    const hex = prefix.trim().toLowerCase()
    if (!/^[0-9a-f]{7,40}$/.test(hex)) throw new GitUnreadable(`"${prefix}" isn't a commit hash`)
    const found = new Set<string>()
    for (const name of await this.dir.list(`objects/${hex.slice(0, 2)}`)) {
      const sha = hex.slice(0, 2) + name
      if (/^[0-9a-f]{40}$/.test(sha) && sha.startsWith(hex)) found.add(sha)
    }
    for (const pack of await this.allPacks()) for (const sha of await pack.find(hex)) found.add(sha)
    if (found.size > 1) throw new GitUnreadable(`${hex} names ${found.size} objects in this .git`)
    const [sha] = found
    if (!sha) throw new GitUnreadable(`commit ${hex.slice(0, 7)} isn't in this code folder${await this.whyMissing()}`)
    return sha
  }

  /** An object by its full hash. Throws GitUnreadable when it isn't here. */
  async object(sha: string): Promise<GitObject> {
    const kept = this.kept.get(sha)
    if (kept) return kept
    const object = (await this.loose(sha)) ?? (await this.packed(sha))
    if (!object) throw new GitUnreadable(`object ${sha.slice(0, 7)} isn't in this code folder${await this.whyMissing()}`)
    this.keep(sha, object)
    return object
  }

  /** The tree a commit points at. */
  async treeOf(commit: string): Promise<string> {
    const object = await this.object(commit)
    if (object.kind !== 'commit') throw new GitUnreadable(`${commit.slice(0, 7)} is a ${object.kind}, not a commit`)
    const tree = /^tree ([0-9a-f]{40})$/m.exec(new TextDecoder().decode(object.data))?.[1]
    if (!tree) throw new GitUnreadable(`commit ${commit.slice(0, 7)} has no tree line`)
    return tree
  }

  async tree(sha: string): Promise<TreeEntry[]> {
    const object = await this.object(sha)
    if (object.kind !== 'tree') throw new GitUnreadable(`${sha.slice(0, 7)} is a ${object.kind}, not a tree`)
    return parseTree(object.data)
  }

  /** Every file in a commit with this file name (any folder), with its blob hash. */
  async filesNamed(commit: string, name: string): Promise<{ path: string; sha: string }[]> {
    const found: { path: string; sha: string }[] = []
    const walk = async (tree: string, folder: string) => {
      for (const e of await this.tree(tree)) {
        if (e.mode === '40000') await walk(e.sha, `${folder}${e.name}/`)
        else if (e.name === name && e.mode !== '160000') found.push({ path: folder + e.name, sha: e.sha })
      }
    }
    await walk(await this.treeOf(commit), '')
    return found
  }

  /** A file's text at a commit, by its path from the top of the repo. */
  async textAt(commit: string, path: string): Promise<string> {
    let tree = await this.treeOf(commit)
    const parts = path.split('/')
    for (const [i, part] of parts.entries()) {
      const entry = (await this.tree(tree)).find((e) => e.name === part)
      if (!entry) throw new GitUnreadable(`${path} isn't in commit ${commit.slice(0, 7)}`)
      if (i < parts.length - 1) tree = entry.sha
      else return new TextDecoder().decode((await this.object(entry.sha)).data)
    }
    throw new GitUnreadable(`no path given`)
  }

  /** A loose object (objects/ab/cdef…), or null if there is none. */
  private async loose(sha: string): Promise<GitObject | null> {
    const bytes = await this.dir.read(`objects/${sha.slice(0, 2)}/${sha.slice(2)}`)
    if (!bytes) return null
    const raw = await inflate(bytes)
    const nul = raw.indexOf(0)
    const [kind, size] = new TextDecoder().decode(raw.subarray(0, nul)).split(' ')
    if (!['commit', 'tree', 'blob', 'tag'].includes(kind) || Number(size) !== raw.length - nul - 1) {
      throw new GitUnreadable(`loose object ${sha.slice(0, 7)} is damaged`)
    }
    return { kind: kind as ObjectKind, data: raw.subarray(nul + 1) }
  }

  private async packed(sha: string): Promise<GitObject | null> {
    for (const pack of await this.allPacks()) {
      const offset = await pack.offsetOf(sha)
      if (offset !== null) return pack.objectAt(offset, (base) => this.object(base))
    }
    return null
  }

  private allPacks(): Promise<Pack[]> {
    this.packs ??= this.dir.list('objects/pack').then((names) =>
      names.filter((n) => /^pack-[0-9a-f]+\.idx$/.test(n)).sort().map((n) => new Pack(this.dir, `objects/pack/${n.slice(0, -4)}`)))
    return this.packs
  }

  /** Why an object may be missing: a shallow clone, or objects borrowed from another repo. */
  private async whyMissing(): Promise<string> {
    if (await this.dir.size('shallow')) return ' (it is a shallow clone: fetch the whole history with git fetch --unshallow)'
    if (await this.dir.size('objects/info/alternates')) return ' (its objects are partly in another repo, objects/info/alternates)'
    return ' (fetch, or pull the branch the robot ran)'
  }

  private keep(sha: string, object: GitObject) {
    if (this.kept.size >= KEEP_OBJECTS) this.kept.delete(this.kept.keys().next().value as string)
    this.kept.set(sha, object)
  }
}

/** One pack: its index (.idx, version 2) and its objects (.pack). */
class Pack {
  private header: Promise<{ fanout: Uint32Array; count: number }> | null = null
  private ends: Promise<{ sorted: number[]; packEnd: number }> | null = null
  private inflated = new Map<number, GitObject>()
  private dir: GitDir
  private base: string

  constructor(dir: GitDir, base: string) {
    this.dir = dir
    this.base = base
  }

  /** The full hashes in this pack that start with a prefix (7+ hex characters). */
  async find(prefix: string): Promise<string[]> {
    const { names } = await this.bucket(parseInt(prefix.slice(0, 2), 16))
    return names.filter((n) => n.startsWith(prefix))
  }

  /** Where an object starts in the .pack, or null if it isn't in this pack. */
  async offsetOf(sha: string): Promise<number | null> {
    const { names, first } = await this.bucket(parseInt(sha.slice(0, 2), 16))
    const i = names.indexOf(sha)
    if (i < 0) return null
    const { count } = await this.index()
    const at = 8 + 1024 + 24 * count + 4 * (first + i)
    const word = new DataView((await this.idx(at, at + 4)).buffer).getUint32(0)
    if ((word & 0x80000000) === 0) return word
    // A pack over 2 GB keeps this offset in the 8-byte table after the 4-byte one.
    const big = 8 + 1024 + 28 * count + 8 * (word & 0x7fffffff)
    return Number(new DataView((await this.idx(big, big + 8)).buffer).getBigUint64(0))
  }

  /** The object at an offset, its delta chain applied. `byHash` reads a REF_DELTA's base (which may be anywhere). */
  async objectAt(offset: number, byHash: (sha: string) => Promise<GitObject>): Promise<GitObject> {
    const kept = this.inflated.get(offset)
    if (kept) return kept
    const head = await this.pack(offset, offset + 32)
    let i = 0
    let byte = head[i++]
    const type = (byte >> 4) & 7
    while (byte & 0x80) byte = head[i++]
    let base: Promise<GitObject> | null = null
    if (type === OFS_DELTA) {
      byte = head[i++]
      let back = byte & 0x7f
      while (byte & 0x80) {
        byte = head[i++]
        back = (back + 1) * 128 + (byte & 0x7f)
      }
      base = this.objectAt(offset - back, byHash)
    } else if (type === REF_DELTA) {
      base = byHash(hex(head.subarray(i, i + 20)))
      i += 20
    } else if (!KINDS[type]) {
      throw new GitUnreadable(`the pack has an object of unknown type ${type}`)
    }
    const data = await inflate(await this.pack(offset + i, await this.endOf(offset)))
    const object = base ? { kind: (await base).kind, data: applyDelta((await base).data, data) } : { kind: KINDS[type], data }
    if (this.inflated.size >= KEEP_OBJECTS) this.inflated.delete(this.inflated.keys().next().value as number)
    this.inflated.set(offset, object)
    return object
  }

  /** The names in one fan-out bucket (all hashes starting with one byte), and the index of the first. */
  private async bucket(firstByte: number): Promise<{ names: string[]; first: number }> {
    const { fanout } = await this.index()
    const first = firstByte === 0 ? 0 : fanout[firstByte - 1]
    const end = fanout[firstByte]
    const bytes = await this.idx(8 + 1024 + 20 * first, 8 + 1024 + 20 * end)
    const names: string[] = []
    for (let k = 0; k < end - first; k++) names.push(hex(bytes.subarray(20 * k, 20 * k + 20)))
    return { names, first }
  }

  private index(): Promise<{ fanout: Uint32Array; count: number }> {
    this.header ??= this.idx(0, 8 + 1024).then((bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (view.getUint32(0) !== 0xff744f63 || view.getUint32(4) !== 2) throw new GitUnreadable(`${this.base}.idx isn't a version 2 pack index`)
      const fanout = new Uint32Array(256)
      for (let b = 0; b < 256; b++) fanout[b] = view.getUint32(8 + 4 * b)
      return { fanout, count: fanout[255] }
    })
    return this.header
  }

  /** Where the object at an offset ends: where the next one starts, or the pack's 20-byte checksum. */
  private async endOf(offset: number): Promise<number> {
    this.ends ??= (async () => {
      const { count } = await this.index()
      const table = await this.idx(8 + 1024 + 24 * count, 8 + 1024 + 28 * count)
      const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
      const offsets: number[] = []
      const bigOnes: number[] = []
      for (let k = 0; k < count; k++) {
        const word = view.getUint32(4 * k)
        if (word & 0x80000000) bigOnes.push(word & 0x7fffffff)
        else offsets.push(word)
      }
      if (bigOnes.length) {
        const big = await this.idx(8 + 1024 + 28 * count, 8 + 1024 + 28 * count + 8 * bigOnes.length)
        const bigView = new DataView(big.buffer, big.byteOffset, big.byteLength)
        for (const k of bigOnes) offsets.push(Number(bigView.getBigUint64(8 * k)))
      }
      const size = await this.dir.size(`${this.base}.pack`)
      if (size === null) throw new GitUnreadable(`${this.base}.pack is missing`)
      return { sorted: offsets.sort((a, b) => a - b), packEnd: size - 20 }
    })()
    const { sorted, packEnd } = await this.ends
    // Binary search for the first offset after this one.
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo < sorted.length ? sorted[lo] : packEnd
  }

  private async idx(start: number, end: number): Promise<Uint8Array> {
    const bytes = await this.dir.read(`${this.base}.idx`, start, end)
    if (!bytes || bytes.length !== end - start) throw new GitUnreadable(`${this.base}.idx is missing or cut short`)
    return bytes
  }

  private async pack(start: number, end: number): Promise<Uint8Array> {
    const bytes = await this.dir.read(`${this.base}.pack`, start, end)
    if (!bytes) throw new GitUnreadable(`${this.base}.pack is missing`)
    return bytes
  }
}

/** A tree's entries: "<mode> <name>\0" then the 20-byte hash, repeated. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = []
  const text = new TextDecoder()
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    const nul = data.indexOf(0, space)
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new GitUnreadable('a tree object is damaged')
    entries.push({ mode: text.decode(data.subarray(i, space)), name: text.decode(data.subarray(space + 1, nul)), sha: hex(data.subarray(nul + 1, nul + 21)) })
    i = nul + 21
  }
  return entries
}

/** Builds an object from its base and a git delta: the two sizes, then copy-from-base and insert instructions. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0
  const size = () => {
    let value = 0
    let shift = 0
    let byte
    do {
      byte = delta[i++]
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
    } while (byte & 0x80)
    return value
  }
  if (size() !== base.length) throw new GitUnreadable('a delta doesn\'t fit its base object')
  const out = new Uint8Array(size())
  let at = 0
  while (i < delta.length) {
    const op = delta[i++]
    if (op & 0x80) {
      let from = 0
      let length = 0
      for (let b = 0; b < 4; b++) if (op & (1 << b)) from += delta[i++] * 2 ** (8 * b)
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) length += delta[i++] * 2 ** (8 * b)
      if (length === 0) length = 0x10000
      if (from + length > base.length || at + length > out.length) throw new GitUnreadable('a delta copies past its base')
      out.set(base.subarray(from, from + length), at)
      at += length
    } else if (op > 0) {
      if (at + op > out.length || i + op > delta.length) throw new GitUnreadable('a delta inserts past its end')
      out.set(delta.subarray(i, i + op), at)
      at += op
      i += op
    } else {
      throw new GitUnreadable('a delta has a reserved instruction')
    }
  }
  if (at !== out.length) throw new GitUnreadable('a delta came out the wrong size')
  return out
}

/** Inflates one zlib stream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
