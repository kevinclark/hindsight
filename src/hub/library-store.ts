/**
 * The library on this machine: a folder holding `logs/…` and `manifests/*.jsonl`. This machine appends only to its own
 * manifest; teammates' manifests are copies made by sync and are only read.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Catalog } from './catalog.ts'
import { LocalFolderAdapter } from './local-adapter.ts'
import { readText } from './adapter.ts'
import { serializeRecord, type ManifestRecord } from './types.ts'

export class LocalLibrary {
  catalog: Catalog
  /** This machine's manifest as it is on disk. */
  private own: string

  readonly store: LocalFolderAdapter
  readonly machine: string

  private constructor(store: LocalFolderAdapter, machine: string, catalog: Catalog, own: string) {
    this.store = store
    this.machine = machine
    this.catalog = catalog
    this.own = own
  }

  get ownManifestPath(): string { return `manifests/${this.machine}.jsonl` }
  get root(): string { return this.store.root }

  static async open(root: string, machine: string): Promise<LocalLibrary> {
    const store = new LocalFolderAdapter(root)
    const lib = new LocalLibrary(store, machine, new Catalog(), '')
    lib.own = (await readText(store, `manifests/${machine}.jsonl`)) ?? ''
    await lib.reload()
    return lib
  }

  /** Read every manifest in the folder again (after sync brought teammates' in). */
  async reload(): Promise<void> {
    const texts: string[] = []
    for (const f of await this.store.list('manifests')) if (f.path.endsWith('.jsonl')) texts.push((await readText(this.store, f.path)) ?? '')
    this.catalog = Catalog.from(texts)
  }

  /** Add records to this machine's manifest, durably, and to the catalog. */
  async append(...records: ManifestRecord[]): Promise<void> {
    if (records.length === 0) return
    const next = this.own + records.map(serializeRecord).join('')
    await this.store.appendManifest(this.ownManifestPath, next)
    this.own = next
    for (const r of records) this.catalog.add(r)
  }

  /** This machine's own records, as lines (what sync publishes). */
  ownLines(): string[] { return this.own.split('\n').filter((l) => l !== '') }
}

/** Small JSON files beside the library that are this machine's own state (the "seen" cache), never shared. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(temp, JSON.stringify(value))
  await rename(temp, path)
}
