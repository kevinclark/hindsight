/**
 * What the page can ask the desktop app (electron/preload.ts exposes it as `window.hub`; it is absent in hindsight.html
 * opened from disk, which has no library). Everything crossing is plain data.
 */
import type { Entry } from './catalog.ts'
import type { IngestPlan, IngestReport } from './ingest.ts'
import type { FetchReport, SyncReport } from './sync.ts'
import type { Update } from './update.ts'
import type { TagField, TagTarget } from './types.ts'

export interface Progress { job: string; done: number; total: number; current: string }

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
  setTag(target: TagTarget, field: TagField, value: string): Promise<void>
  /** The bytes of a log in the library (path as in the manifest). */
  readLog(path: string): Promise<Uint8Array>
  onProgress(callback: (p: Progress) => void): () => void

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
  updateInfo(): Promise<Update | null>
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
  private readonly path: string
  private readonly api: HubApi
  constructor(name: string, size: number, lastModified: number, path: string, api: HubApi) {
    this.name = name; this.size = size; this.lastModified = lastModified; this.path = path; this.api = api
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.api.readLog(this.path)
    // The bytes usually fill their buffer: hand it over rather than copy a log that can be hundreds of MB.
    return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer
  }
}
