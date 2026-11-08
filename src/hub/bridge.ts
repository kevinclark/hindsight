/**
 * What the page can ask the desktop app (electron/preload.ts exposes it as `window.hub`; it is absent in hindsight.html
 * opened from disk, which has no library). Everything crossing is plain data.
 */
import type { Entry } from './catalog.ts'
import type { IngestPlan, IngestReport } from './ingest.ts'
import type { FetchReport, SyncReport } from './sync.ts'
import type { Update } from './update.ts'
import type { RedescribeReport } from './redescribe.ts'
import type { TagField, TagTarget } from './types.ts'
import type { Fetched, TbaGetOptions } from '../tba/source.ts'
import type { NexusEvent } from '../nexus/source.ts'
import type { ShareStatus } from './live-share.ts'
import type { BrowserHub } from './browser-hub.ts'
export type { ShareStatus } from './live-share.ts'

import type { JobProgress } from './jobs.ts'
export type Progress = JobProgress

/** The job that finished last (kept by the app, so a page that reloaded can still show how it ended). */
export interface LastJob { job: string; report?: unknown; error?: string; at: number }

/** The GitHub sources code is linked from, and the most API requests "Link code" would make. */
export interface CodePlan {
  sources: string[]
  /** A floor, not a total: one listing per source plus one commit check per distinct (Codebase text, build commit); a text recorded by several repos costs one check per repo. */
  requests: number
  /** Logs "Link code" would look at. */
  logs: number
  /** Some robot log has no describer stamp: it was filed before this version read logs, so "Read logs again" may find its robot. */
  unstamped: boolean
}

/** The saved team number (null: none) and GitHub sources; `setTeam` also says whether the sources need a Link code pass. */
export interface TeamSettingSaved {
  team: number | null
  sources: string[]
  /** Whether a The Blue Alliance read key is saved on this laptop. The key itself never reaches the page. */
  tbaKey?: boolean
  /** Whether a Nexus API key is saved on this laptop (never the key). */
  nexusKey?: boolean
  /** Only from `setTeam`: the sources differ from those of the last full link pass that finished. */
  linkNeeded?: boolean
}

export interface LinkReport {
  /** Logs that found a repo. */
  linked: number
  /** Of those, how many wrote a record and how many already had the same link. */
  written: number
  unchanged: number
  /** Logs with a Codebase text that no listed repo records. */
  unmatched: number
  repos: number
  requests: { api: number; raw: number }
  /** When GitHub's request limit was hit: when it resets (ms since 1970). */
  rateLimitedUntil: number | null
  problems: string[]
}

export interface LibrarySnapshot {
  entries: Entry[]
  /** Manifest lines that could not be read. */
  skipped: number
  libraryDir: string
  machineId: string
}

export interface DriveStatus {
  /** The build (or the team) supplied a Google client. */
  configured: boolean
  signedIn: boolean
  teamFolder: { id: string; name: string } | null
  /** Whether the sign-in is kept between runs, and if not, why. */
  keepsSignIn: boolean
  keepWarning: string | null
  /** When the last sync finished (ms), if any. */
  lastSync: number | null
}

export interface SyncPlan { uploads: number; uploadBytes: number }

export type RobotResult = { refused: string } | { report: IngestReport; stillWriting: string[] }

export interface HubApi {
  info(): Promise<{ version: string; machineId: string; libraryDir: string }>
  library(): Promise<LibrarySnapshot>
  /** Choose a folder on this machine and bring its logs in. Resolves with the report, or null if the dialog was cancelled. */
  addFromFolder(): Promise<IngestReport | null>
  cancel(): Promise<void>
  /** The running job's latest progress, or null when none runs (a page that loads mid-job asks this). */
  runningJob(): Promise<Progress | null>
  /** The job that finished last, or null if none has since the app started. */
  lastJob(): Promise<LastJob | null>
  codePlan(): Promise<CodePlan>
  /** The saved team number and GitHub sources. */
  team(): Promise<TeamSettingSaved>
  /** Save the team number (null: none), the GitHub sources and, when given (undefined keeps it, null or '' clears it), the read key together. Makes no GitHub request; `linkNeeded` tells the page to run `linkCode()`. Throws if either is not valid. */
  setTeam(team: number | null, sources: string[], tbaKey?: string | null): Promise<TeamSettingSaved>
  /** One of the three The Blue Alliance reads (src/tba/source.ts) with the saved key, answered from the saved copy when offline. Throws without a key. */
  tba<T>(path: string, opts?: TbaGetOptions): Promise<Fetched<T>>
  /** Save (a string) or clear (null or '') the Nexus API key. Throws if it does not look like one. */
  setNexusKey(key: string | null): Promise<{ nexusKey: boolean }>
  /** Nexus's live status of one event (src/nexus/source.ts) with the saved key, answered from the saved copy when offline. Throws without a key. */
  nexus(eventKey: string): Promise<Fetched<NexusEvent>>
  /** Find, for logs that name only a code name, the repo that holds that code; makes GitHub requests (see codePlan). */
  linkCode(): Promise<LinkReport>
  /** Read this library's robot logs again with the current describer; resolves with what changed. */
  redescribe(): Promise<RedescribeReport>
  /** The team's triage history (every machine's `history/*.jsonl` folded), as the text of one hindsight-history.jsonl. */
  history(): Promise<string>
  /** Append lines to this machine's own history file; lines already in the library are skipped. Resolves with how many were written. */
  appendHistory(text: string): Promise<number>
  setTag(target: TagTarget, field: TagField, value: string): Promise<void>
  /** The bytes of a log in the library (path as in the manifest). */
  readLog(path: string): Promise<Uint8Array>
  /** Open a log in AdvantageScope: a library path (must be on this computer) or a file's absolute path. Throws with a sentence for the user. */
  openInAdvantageScope(target: { library: string } | { file: string }): Promise<void>
  /** Where a file the user picked or dropped lives on disk ('' when it isn't a file on disk). */
  pathForFile(file: File): string
  /** Progress of any job; `null` when the job ended. */
  onProgress(callback: (p: Progress | null) => void): () => void
  /** Append the page's summaries of an event's logs (event-file lines) to this laptop's file for the phone; resolves with how many were new. */
  appendEvent(key: string, text: string): Promise<number>
  /** What of this laptop's marks and event lines is not on the team Drive yet, and when teammates' marks were last brought down. */
  shareStatus(): Promise<ShareStatus>
  /** Bring teammates' marks down now (the window came to the front); does nothing before a sign-in is in use. */
  shareNow(): Promise<void>
  /** Teammates' marks were brought down (or Sync brought history): read the history again. */
  onHistoryChanged(callback: () => void): () => void
  onShareStatus(callback: (s: ShareStatus) => void): () => void

  driveStatus(): Promise<DriveStatus>
  driveSignIn(): Promise<void>
  driveSignOut(): Promise<void>
  setGoogleClient(id: string, secret: string): Promise<void>
  /** Folders under a folder ('roots' for My Drive and the shared drives). */
  driveFolders(parentId: string): Promise<{ id: string; name: string }[]>
  /** Remember the team folder (an id or a link). Throws if it can't be seen. */
  setTeamFolder(idOrLink: string): Promise<{ id: string; name: string }>
  /** What bringing a Drive folder in would cost, before any file is downloaded. */
  driveIngestPlan(folderIdOrLink: string): Promise<IngestPlan>
  addFromDrive(folderIdOrLink: string): Promise<IngestReport>
  syncPlan(): Promise<SyncPlan>
  sync(): Promise<SyncReport>
  /** Download logs the team has and this computer lacks (library paths). */
  fetchLogs(paths: string[]): Promise<FetchReport>
  addFromRobot(address: string): Promise<RobotResult>
  /** Reveal the job log (`jobs.log`: what each job did, with times) in Finder or Explorer. */
  showJobLog(): Promise<void>
  updateInfo(): Promise<Update | null>
}

/**
 * The phone's hub (src/hub/browser-hub.ts): read only, straight from the team's Drive. Kept apart from `hub()`, which means
 * "the desktop app" to every place that offers adding logs, the Library or a sync. Set by the phone's entry before the page
 * mounts (src/phone.ts); absent on the desktop and on the page opened from disk.
 */
export function phone(): BrowserHub | undefined {
  return (window as unknown as { hindsightPhone?: BrowserHub }).hindsightPhone
}

export function hub(): HubApi | undefined {
  return (window as unknown as { hub?: HubApi }).hub
}

/**
 * A log in the library as the Session view takes it: it only asks for name, size, modified time and the bytes, so the
 * bytes are fetched when asked, one log at a time, not all held at once.
 */
export class LibraryFile {
  readonly webkitRelativePath = ''
  readonly name: string
  readonly size: number
  readonly lastModified: number
  /** The path as in the manifest. */
  readonly libraryPath: string
  private readonly api: HubApi
  constructor(name: string, size: number, lastModified: number, path: string, api: HubApi) {
    this.name = name; this.size = size; this.lastModified = lastModified; this.libraryPath = path; this.api = api
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.api.readLog(this.libraryPath)
    // The bytes usually fill their buffer: hand it over rather than copy a log that can be hundreds of MB.
    return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer
  }
}
