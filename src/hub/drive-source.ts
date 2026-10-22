/** A Drive folder (any the user can see, recursive) as ingest sources. Listing reads nothing; a file is downloaded, in full, only when ingest must read it. */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DriveAdapter } from './drive-adapter.ts'
import type { SourceFile } from './ingest.ts'
import { kindOf } from './types.ts'

/** A folder id from what was pasted: a bare id, or a drive.google.com/drive/folders/<id> link. */
export function folderIdFrom(text: string): string | null {
  const t = text.trim()
  const fromLink = /\/folders\/([\w-]+)/.exec(t)?.[1] ?? /[?&]id=([\w-]+)/.exec(t)?.[1]
  return fromLink ?? (/^[\w-]{10,}$/.test(t) ? t : null)
}

export async function driveFolderFiles(drive: DriveAdapter, folderId: string, tempRoot = tmpdir()): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  const walk = async (id: string, where: string) => {
    for (const f of (await drive.childrenOf(id)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.isFolder) { await walk(f.id, `${where}${f.name}/`); continue }
      // The Google Docs kinds have no bytes and no size; only log files matter anyway.
      if (kindOf(f.name) === null) { out.push({ name: f.name, where: `${where}${f.name}`, size: 0, modifiedTime: null, from: 'drive', open: async () => { throw new Error('not a log') } }); continue }
      out.push({
        name: f.name, where: `${where}${f.name}`, size: f.size, modifiedTime: f.modifiedTime, from: 'drive', sourceId: f.id, sha256: f.sha256, md5: f.md5,
        cacheKey: `drive:${f.id}|${f.size}|${f.md5 ?? f.modifiedTime}`,
        open: async () => {
          const dir = await mkdtemp(join(tempRoot, 'hindsight-drive-'))
          const path = join(dir, f.name.replace(/[\\/]/g, '_'))
          const sink = createWriteStream(path)
          try {
            await drive.download(f.id, f.size, (chunk) => new Promise((resolve, reject) => sink.write(chunk, (e) => (e ? reject(e) : resolve()))))
            await new Promise<void>((resolve, reject) => sink.end((e?: Error | null) => (e ? reject(e) : resolve())))
          } catch (e) { sink.destroy(); await rm(dir, { recursive: true, force: true }); throw e }
          return { path, done: () => rm(dir, { recursive: true, force: true }) }
        },
      })
    }
  }
  await walk(folderId, '')
  return out
}
