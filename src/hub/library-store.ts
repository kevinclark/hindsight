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
import { mergeHistory, parseHistory, serializeHistory, type HistoryEvent } from '../triage/history.ts'
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

  /** Read every manifest in the folder again, this machine's own too (after sync brought teammates' in, or another process appended). */
  async reload(): Promise<void> {
    this.own = (await readText(this.store, this.ownManifestPath)) ?? ''
    const texts: string[] = []
    for (const f of await this.store.list('manifests')) if (f.path.endsWith('.jsonl')) texts.push((await readText(this.store, f.path)) ?? '')
    this.catalog = Catalog.from(texts)
  }

  /** Add records to this machine's manifest, durably, and to the catalog. */
  async append(...records: ManifestRecord[]): Promise<void> {
    if (records.length === 0) return
    // A crash can leave the last line without its newline: start a fresh line rather than join the next record to it.
    const lines = (this.own !== '' && !this.own.endsWith('\n') ? '\n' : '') + records.map(serializeRecord).join('')
    await this.store.appendOwn(this.ownManifestPath, lines)
    this.own += lines
    for (const r of records) this.catalog.add(r)
  }

  get ownHistoryPath(): string { return `history/${this.machine}.jsonl` }

  /** The text of every machine's triage history file (this machine's first), read from disk each time. */
  private async historyTexts(): Promise<string[]> {
    const texts: string[] = []
    for (const f of await this.store.list('history')) if (f.path.endsWith('.jsonl') && f.path !== this.ownHistoryPath) texts.push((await readText(this.store, f.path)) ?? '')
    return [(await readText(this.store, this.ownHistoryPath)) ?? '', ...texts]
  }

  /** The team's triage history as one file's text: every machine's file folded in (by when, device, seq); lines this build can't type are kept as they came. */
  async historyText(): Promise<string> {
    let events: HistoryEvent[] = []
    for (const t of await this.historyTexts()) events = mergeHistory(events, parseHistory(t).events)
    return serializeHistory(events)
  }

  /**
   * Add lines (a text of JSON lines) to this machine's history file, durably. A line already in any machine's file
   * (exact text) is not added again. Returns how many lines were written.
   */
  async appendHistory(text: string): Promise<number> {
    const texts = await this.historyTexts()
    const have = new Set(texts.flatMap((t) => t.split('\n')).filter((l) => l.trim() !== ''))
    const fresh: string[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '' || have.has(line)) continue
      have.add(line)
      fresh.push(line)
    }
    if (fresh.length === 0) return 0
    // A crash can leave the last line without its newline: start a fresh line rather than join the next one to it.
    const own = texts[0]
    await this.store.appendOwn(this.ownHistoryPath, (own !== '' && !own.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n')
    return fresh.length
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
