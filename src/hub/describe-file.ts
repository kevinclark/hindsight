/** Read a log file from disk and describe it: its hashes and what it says about itself. Runs in a utility process (electron/describe-worker.ts) and in tests. */
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describeHoot, describeLog } from './describe.ts'
import { kindOf, type LogMeta } from './types.ts'
import { hashFile } from './local-adapter.ts'

export interface Described { sha256: string; md5: string; size: number; meta: LogMeta }

/** Hash `path` and describe it as `name` (the name decides the kind and, for a hoot, the date). One file at a time: a practice log is 672 MB. */
export async function describeFile(path: string, name: string): Promise<Described> {
  const kind = kindOf(name)
  if (kind === 'hoot') {
    const h = await hashFile(path)
    return { ...h, size: (await stat(path)).size, meta: describeHoot(name) }
  }
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const md5 = createHash('md5').update(bytes).digest('hex')
  return { sha256, md5, size: bytes.length, meta: describeLog(name, bytes) }
}
