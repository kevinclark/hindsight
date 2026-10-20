/**
 * Saved summaries from an older Hindsight. A summary is saved with the build that read it, the shape of the summary
 * and the Hindsight version. After an update, the ones with the same shape are still shown (marked as read with an
 * older Hindsight, so "Read again" can update them); the ones with another shape can't be drawn, so they are only
 * counted. Nothing here touches the browser's storage.
 */
import type { MatchSummary } from './summary.ts'
import { dateText } from './session.ts'

export interface SavedSummary {
  key: string
  build: string
  savedAt: string
  /** The shape of the summary (SUMMARY_SHAPE) when it was saved. Absent in copies saved before this was kept. */
  shape?: number
  /** The Hindsight version that read the log. Absent in copies saved before this was kept. */
  version?: string
  summary: MatchSummary
}

export interface SplitSaved {
  /** Read by this build of Hindsight. */
  current: SavedSummary[]
  /** Read by another build, with a summary this build can still show. */
  stale: SavedSummary[]
  /** Read by another build, with a shape this build can't show: only counted. */
  otherShape: SavedSummary[]
}

/** Sort saved summaries into this build's, older builds' with the same shape, and older builds' with another shape. */
export function splitSaved(all: SavedSummary[], build: string, shape: number): SplitSaved {
  const out: SplitSaved = { current: [], stale: [], otherShape: [] }
  for (const c of all) {
    if (c.build === build) out.current.push(c)
    else if (c.shape === shape) out.stale.push(c)
    else out.otherShape.push(c)
  }
  return out
}

/**
 * The note for the page, or null when there is nothing to say. `shown` are the saved copies on the page that an older
 * Hindsight read; `hidden` is how many saved copies can't be shown at all.
 */
export function staleNote(shown: { version?: string; savedAt: string }[], hidden: number): string | null {
  const parts: string[] = []
  if (shown.length) {
    const versions = [...new Set(shown.map((s) => s.version).filter((v): v is string => !!v))]
    const oldest = shown.map((s) => s.savedAt).sort()[0]
    const which = versions.length ? `version ${versions.join(', ')}, ` : ''
    parts.push(`${shown.length} log${shown.length === 1 ? ' was' : 's were'} read with an older Hindsight (${which}saved ${dateText(Date.parse(oldest))}). Read again to update the conclusions.`)
  }
  if (hidden) {
    parts.push(`${hidden} more saved log summar${hidden === 1 ? 'y was' : 'ies were'} made by a Hindsight too old to show here: choose ${hidden === 1 ? 'that log' : 'those logs'} again to read ${hidden === 1 ? 'it' : 'them'}.`)
  }
  return parts.length ? parts.join(' ') : null
}
