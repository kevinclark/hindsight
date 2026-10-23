/**
 * Link the logs an ingest just added to their code, in the same job. Only logs this ingest added, that name only a code
 * name (`linkable`) and have no link yet; at most `maxRequests` GitHub API requests (a cap, not GitHub's limit). Logs
 * linked by their Codebase text alone are not looked at again here: the Link code button does the full pass.
 */
import { ADD_LINK_REQUESTS, linkable, linkCode } from './codelink.ts'
import type { IngestReport } from './ingest.ts'
import { applyLinks } from './links.ts'
import type { LocalLibrary } from './library-store.ts'

export interface AddLinkOptions {
  get?: typeof fetch
  now?: () => number
  cancelled?: () => boolean
  maxRequests?: number
  onProgress?: (done: number, total: number, current: string) => void
}

export type AddLinkResult = Pick<IngestReport, 'linked' | 'linkRequests' | 'linkCapped'>

/** Nothing is asked of GitHub when no source is set or no added log is linkable. Returns null for an ingest that was cancelled (`report` is then partial): nothing is linked. */
export async function linkAdded(lib: LocalLibrary, report: IngestReport, sources: string[], describer: string, options: AddLinkOptions = {}): Promise<AddLinkResult | null> {
  if (options.cancelled?.()) return null
  const todo = report.added.flatMap((a) => {
    const r = lib.catalog.byPath(a.path)
    return r && linkable(r) && !r.code ? [r] : []
  })
  if (sources.length === 0 || todo.length === 0) return { linked: 0, linkRequests: 0, linkCapped: false }
  const found = await linkCode(sources, todo, { ...options, maxRequests: options.maxRequests ?? ADD_LINK_REQUESTS })
  await applyLinks(lib, found.links, describer, options.now)
  return { linked: found.links.size, linkRequests: found.requests.api, linkCapped: found.capped }
}
