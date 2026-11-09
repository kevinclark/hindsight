/**
 * The update chip's decision: what the updater has told us (`UpdateEvent`) becomes one `UpdateState`, and `chip` says it in
 * words. Pure (no Electron, no Node, no clock: the time is passed in), so the main process and the page run the same code.
 * Contract: docs/contracts/update-state.md.
 */
import { isNewer } from './update.ts'

export type UpdateState =
  | { kind: 'dev'; version: string }
  | { kind: 'checking'; version: string; checkedAt: number | null }
  | { kind: 'current'; version: string; checkedAt: number }
  | { kind: 'downloading'; version: string; next: string; transferred: number; total: number; bytesPerSecond: number; lastDataAt: number }
  | { kind: 'ready'; version: string; next: string }
  | { kind: 'failed'; version: string; checkedAt: number | null; since: number; reason: string }
  | { kind: 'manual'; version: string; next: string; url: string; checkedAt: number }

export type UpdateEvent =
  | { type: 'checking' } | { type: 'none' } | { type: 'available'; next: string }
  | { type: 'progress'; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'downloaded'; next: string } | { type: 'error'; reason: string }
  | { type: 'manual'; next: string; url: string }

/** A check every four hours: releases ship up to ten a day. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** A download with no new bytes for this long is said to have stalled (the same 15 s the robot pull uses). */
export const STALL_MS = 15_000

/** Not packaged and not self-updating is a development run, which never checks; anything else starts by checking. */
export function initial(version: string, selfUpdating: boolean, packaged: boolean): UpdateState {
  return !packaged && !selfUpdating ? { kind: 'dev', version } : { kind: 'checking', version, checkedAt: null }
}

const startDownload = (version: string, next: string, now: number): UpdateState =>
  ({ kind: 'downloading', version, next, transferred: 0, total: 0, bytesPerSecond: 0, lastDataAt: now })

export function step(s: UpdateState, e: UpdateEvent, now: number): UpdateState {
  if (s.kind === 'dev') return s
  if (s.kind === 'ready') {
    // Sticky: the staged update installs on quit whatever a later check says. Only a newer release replaces it.
    if (e.type === 'available' && isNewer(e.next, s.next)) return startDownload(s.version, e.next, now)
    if (e.type === 'downloaded' && isNewer(e.next, s.next)) return { kind: 'ready', version: s.version, next: e.next }
    return s
  }
  switch (e.type) {
    case 'checking':
      if (s.kind === 'checking') return s
      return s.kind === 'current' ? { kind: 'checking', version: s.version, checkedAt: s.checkedAt } : s
    case 'none':
      return s.kind === 'downloading' ? s : { kind: 'current', version: s.version, checkedAt: now }
    case 'available':
      return s.kind === 'downloading' && s.next === e.next ? s : startDownload(s.version, e.next, now)
    case 'progress':
      if (s.kind !== 'downloading') return s
      return { ...s, transferred: e.transferred, total: e.total, bytesPerSecond: e.bytesPerSecond, lastDataAt: e.transferred > s.transferred ? now : s.lastDataAt }
    case 'downloaded':
      return { kind: 'ready', version: s.version, next: e.next }
    case 'error':
      if (s.kind === 'manual') return s
      return {
        kind: 'failed', version: s.version, reason: e.reason,
        checkedAt: s.kind === 'downloading' ? null : s.checkedAt,
        since: s.kind === 'failed' ? s.since : now,
      }
    case 'manual':
      return { kind: 'manual', version: s.version, next: e.next, url: e.url, checkedAt: now }
  }
}

export interface Chip { text: string; action: 'restart' | 'retry' | 'download' | 'whatsnew' | null; accent: boolean; title: string }

/** The clock time the Library uses for "synced 10:42 AM". */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function chip(s: UpdateState, now: number, whatsNewVersion: string | null): Chip {
  const X = s.version
  switch (s.kind) {
    case 'dev':
      return { text: `${X} · dev build`, action: null, accent: false, title: `Hindsight ${X} is a development build and does not update itself.` }
    case 'checking':
      return { text: `${X} · checking…`, action: null, accent: false, title: `Hindsight ${X} is checking for a newer version.` }
    case 'current':
      if (whatsNewVersion === X) return { text: `Updated to ${X} · What's new`, action: 'whatsnew', accent: true, title: `Hindsight is now ${X}; open this to see what changed.` }
      return { text: `${X} · up to date, checked ${clock(s.checkedAt)}`, action: null, accent: false, title: `Hindsight ${X} is the newest version, as of ${clock(s.checkedAt)}.` }
    case 'downloading': {
      const quiet = now - s.lastDataAt
      const text = quiet >= STALL_MS ? `Downloading ${s.next} · no data for ${Math.round(quiet / 1000)} s`
        : s.total > 0 ? `Downloading ${s.next} · ${Math.round(s.transferred / 1e6)} of ${Math.round(s.total / 1e6)} MB` : `Downloading ${s.next}`
      return { text, action: null, accent: false, title: `Hindsight ${s.next} is downloading in the background; you are on ${X}.` }
    }
    case 'ready':
      return { text: `${s.next} ready · Restart to update`, action: 'restart', accent: true, title: `Hindsight ${s.next} is downloaded. Restart now, or it installs the next time you quit.` }
    case 'failed':
      return { text: `${X} · couldn't check since ${clock(s.since)} · Retry`, action: 'retry', accent: false, title: `Hindsight ${X} could not reach GitHub to check for updates since ${clock(s.since)}; select this to try again.` }
    case 'manual':
      return { text: `${s.next} is out · Download`, action: 'download', accent: false, title: `Hindsight ${s.next} is out; this copy is ${X} and cannot update itself, so download the new one.` }
  }
}
