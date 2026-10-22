/** Write the code links found by src/hub/codelink.ts into the library as `meta` records. Main process and tests. */
import { isDeepStrictEqual } from 'node:util'
import type { LocalLibrary } from './library-store.ts'
import { readingOf } from './redescribe.ts'
import type { CodeLink } from './types.ts'

const sameLink = (a: CodeLink | undefined, b: CodeLink): boolean => !!a && isDeepStrictEqual({ ...a, checkedAt: 0 }, { ...b, checkedAt: 0 })

/**
 * One `meta` record per log whose link is new or different (a link equal but for `checkedAt` writes nothing). The record is the
 * log's reading as the library shows it now plus the link, and names the describer of the reading it copied; a log with no meta
 * yet has none, so `describer` (this build's id) is written, never an empty one. Returns how many were written and how many were already as found.
 */
export async function applyLinks(lib: LocalLibrary, links: ReadonlyMap<string, CodeLink>, describer: string, now: () => number = Date.now): Promise<{ written: number; unchanged: number }> {
  let written = 0
  let unchanged = 0
  for (const [sha256, code] of links) {
    const current = lib.catalog.bySha(sha256)
    if (!current) continue
    if (sameLink(current.code, code)) { unchanged++; continue }
    await lib.append({ type: 'meta', sha256, meta: { ...readingOf(current), code }, describer: lib.catalog.metaOf(sha256)?.describer || describer, recordedAt: now(), machine: lib.machine })
    written++
  }
  return { written, unchanged }
}
