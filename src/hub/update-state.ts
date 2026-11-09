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
  /** A newer release is out, and its download waits for the user's own job (a pull, a Sync…) to finish. */
  | { kind: 'waiting'; version: string; next: string; job: string }

export type UpdateEvent =
  | { type: 'checking' } | { type: 'none' } | { type: 'available'; next: string }
  | { type: 'progress'; transferred: number; total: number; bytesPerSecond: number }
  | { type: 'downloaded'; next: string } | { type: 'error'; reason: string }
  | { type: 'manual'; next: string; url: string }
  /** macOS's Squirrel couldn't fetch or unpack what was downloaded: the update will not install. */
  | { type: 'install-failed'; reason: string }
  /** The user's job `job` runs: the download of `next` waits (or stops, to start again after). */
  | { type: 'wait'; next: string; job: string }

/** A check every four hours: releases ship up to ten a day. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
/** A download with no new bytes for this long is said to have stalled (the same 15 s the robot pull uses). */
export const STALL_MS = 15_000
/** A download with no new bytes for this long is given up (the updater cancels it and the chip offers Retry). */
export const STALL_ABORT_MS = 120_000

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
    if (e.type === 'install-failed') return { kind: 'failed', version: s.version, checkedAt: null, since: now, reason: `${s.next} was downloaded but macOS couldn't prepare it (${e.reason})` }
    return s
  }
  switch (e.type) {
    case 'checking':
      if (s.kind === 'checking') return s
      if (s.kind === 'waiting') return { kind: 'checking', version: s.version, checkedAt: null }
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
        checkedAt: s.kind === 'downloading' || s.kind === 'waiting' ? null : s.checkedAt,
        since: s.kind === 'failed' ? s.since : now,
      }
    case 'install-failed':
      return s
    case 'wait':
      if (s.kind === 'manual') return s
      return s.kind === 'waiting' && s.next === e.next && s.job === e.job ? s : { kind: 'waiting', version: s.version, next: e.next, job: e.job }
    case 'manual':
      return { kind: 'manual', version: s.version, next: e.next, url: e.url, checkedAt: now }
  }
}

/** A job's name as the update label says it: "waits for the Sync" (the log download's job is named just "Downloading"). */
const JOB_PHRASES: Record<string, string> = {
  'Syncing': 'the Sync', 'Downloading': 'the log download', 'Pulling logs off the robot': 'the robot pull',
  'Reading device logs (.hoot)': 'the .hoot read', "Getting CTRE's converter (owlet)": "the owlet download",
  'Reading logs again': 'Read logs again', 'Linking code': 'Link code',
}
export const jobPhrase = (job: string): string => JOB_PHRASES[job] ?? job.charAt(0).toLowerCase() + job.slice(1)

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
      return { text: `${X} · couldn't update since ${clock(s.since)} · Retry`, action: 'retry', accent: false, title: `Hindsight ${X} could not check for or download an update since ${clock(s.since)}; select this to try again.` }
    case 'waiting': {
      const job = jobPhrase(s.job)
      return { text: `${s.next} waits for ${job}`, action: null, accent: false, title: `Hindsight ${s.next} downloads when ${job} finishes; your work comes first.` }
    }
    case 'manual':
      return { text: `${s.next} is out · Download`, action: 'download', accent: false, title: `Hindsight ${s.next} is out; this copy is ${X} and cannot update itself, so download the new one.` }
  }
}
