/** The page's way into the library. Each handler is thin: the work is in src/hub/. */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { filesToFetch } from '../src/hub/catalog.ts'
import { LocalLibrary, readJson, writeJson } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles, planIngest, type IngestReport, type SourceFile } from '../src/hub/ingest.ts'
import { checkPath } from '../src/hub/adapter.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { driveFolderFiles, folderIdFrom } from '../src/hub/drive-source.ts'
import { fetchLogs, syncWithTeam } from '../src/hub/sync.ts'
import { checkRobotIdle, connectRobotFs, robotFiles } from '../src/hub/robot.ts'
import { checkForUpdate } from '../src/hub/update.ts'
import { JobRunner, type Work } from '../src/hub/jobs.ts'
import { applyLinks } from '../src/hub/links.ts'
import { redescribe, type RedescribeReport } from '../src/hub/redescribe.ts'
import { estimateRequests, linkable, linkCode } from '../src/hub/codelink.ts'
import { linkAdded } from '../src/hub/ingest-link.ts'
import { checkTeamSetting, needsLinkPass } from '../src/hub/team-setting.ts'
import type { CodePlan, DriveStatus, TeamSettingSaved, LastJob, LibrarySnapshot, LinkReport, Progress, RobotResult, SyncPlan } from '../src/hub/bridge.ts'
import type { TagField, TagTarget } from '../src/hub/types.ts'
import { Describer } from './describer.ts'
import { driveToken, googleClient, keeping, signIn, signOut, signedIn } from './google-auth.ts'
import { loadSettings, saveSettings } from './settings.ts'

declare const __BUILD_ID__: string
/** Names this build of the describer on the `meta` records it writes: "<app version>+<source hash>" (the version orders builds; the hash only tells them apart). */
const describerId = (version: string) => `${version}+${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}`

export function registerHub(window: () => BrowserWindow | null): void {
  const describer = new Describer()
  let library: Promise<LocalLibrary> | null = null
  const jobs = new JobRunner()
  const open = () => (library ??= loadSettings().then((s) => LocalLibrary.open(s.libraryDir, s.machineId)))
  const seenFile = () => join(app.getPath('userData'), 'seen.json')
  const send = (channel: string, payload: unknown) => window()?.webContents.send(channel, payload)

  // The one request to the public repo's releases, made once on start.
  const update = checkForUpdate(app.getVersion())

  /** One job at a time (an import, a sync, a download): they share the library's manifest and the user's attention. */
  const job = <T>(name: string, work: Work<T>): Promise<T> =>
    jobs.run(name, work, (p) => send('hub:progress', p))

  async function teamStore(): Promise<DriveAdapter> {
    const folder = (await loadSettings()).teamFolder
    if (!folder) throw new Error('Choose the team folder first.')
    return new DriveAdapter({ rootId: folder.id, token: await driveToken() })
  }
  const sourceStore = async () => new DriveAdapter({ rootId: (await loadSettings()).teamFolder?.id ?? 'root', token: await driveToken() })

  async function runIngest(name: string, files: SourceFile[]): Promise<IngestReport> {
    const lib = await open()
    const seenPath = seenFile()
    const seen = new Map(Object.entries(await readJson<Record<string, string>>(seenPath, {})))
    return job(name, async (j, progress) => {
      const report = await ingest(lib, files, { describe: describer.describe, seen, cancelled: () => j.cancelled, onProgress: progress })
      await writeJson(seenPath, Object.fromEntries(seen))
      // Logs just added that name only their code are linked to the saved GitHub sources, at most 20 API requests (a cancelled add links nothing).
      const sources = (await loadSettings()).codeSources ?? []
      if (sources.length > 0) {
        try { Object.assign(report, await linkAdded(lib, report, sources, `${app.getVersion()}+linked`, { cancelled: () => j.cancelled, onProgress: progress })) } catch (e) { report.linkProblem = e instanceof Error ? e.message : String(e) }
      }
      return report
    })
  }

  ipcMain.handle('hub:info', async () => {
    const lib = await open()
    return { version: app.getVersion(), machineId: lib.machine, libraryDir: lib.root }
  })

  ipcMain.handle('hub:library', async (): Promise<LibrarySnapshot> => {
    const lib = await open()
    const shared = new Set((await loadSettings()).lastSync?.paths ?? [])
    const entries = lib.catalog.entries()
    await Promise.all(entries.map(async (e) => {
      const held = new Set<string>()
      await Promise.all([e.record, ...e.attached.dslog, ...e.attached.dsevents, ...e.attached.hoot].map(async (r) => {
        if ((await stat(lib.store.at(r.path)).catch(() => null)) !== null) held.add(r.path)
      }))
      e.local = held.has(e.record.path)
      e.shared = shared.has(e.record.path)
      e.toFetch = filesToFetch(e, held, shared)
    }))
    return { entries, skipped: lib.catalog.skipped, libraryDir: lib.root, machineId: lib.machine }
  })

  ipcMain.handle('hub:addFromFolder', async (): Promise<IngestReport | null> => {
    const picked = process.env.HINDSIGHT_PICK_FOLDER ?? (await dialog.showOpenDialog({ title: 'Add logs from a folder', properties: ['openDirectory'] })).filePaths[0]
    return picked ? runIngest('Reading folder', await localFolderFiles(picked)) : null
  })

  ipcMain.handle('hub:cancel', () => jobs.cancel())
  ipcMain.handle('hub:runningJob', (): Progress | null => jobs.current())

  ipcMain.handle('hub:lastJob', (): LastJob | null => jobs.lastFinished as LastJob | null)

  const codePlan = async (): Promise<CodePlan> => {
    const [lib, settings] = [await open(), await loadSettings()]
    const sources = settings.codeSources ?? []
    const records = lib.catalog.all()
    return {
      sources, requests: estimateRequests(sources, records), logs: records.filter(linkable).length,
      unstamped: records.some((r) => r.kind === 'wpilog' && !lib.catalog.metaOf(r.sha256)?.describer),
    }
  }
  ipcMain.handle('hub:codePlan', codePlan)
  ipcMain.handle('hub:setCodeSources', async (_e, sources: string[]): Promise<CodePlan> => {
    await saveSettings({ codeSources: checkTeamSetting(null, sources).sources })
    return codePlan()
  })
  /** The full pass: find the repo each code-named log ran, from the saved GitHub sources, uncapped; writes a `meta` record for each log linked. */
  const linkPass = async (): Promise<LinkReport> => {
    const lib = await open()
    const sources = (await loadSettings()).codeSources ?? []
    if (sources.length === 0) throw new Error('Add a GitHub organization or repository first.')
    return job('Linking code', async (j, progress) => {
      const found = await linkCode(sources, lib.catalog.all(), { cancelled: () => j.cancelled, onProgress: progress })
      // A log with no reading yet is stamped with this version but not this describer: it ranks as current, yet "Read logs again" still reads it.
      const { written, unchanged } = await applyLinks(lib, found.links, `${app.getVersion()}+linked`)
      return { linked: found.links.size, written, unchanged, unmatched: found.unmatched, repos: found.repos, requests: found.requests, rateLimitedUntil: found.rateLimitedUntil, problems: found.problems }
    })
  }
  ipcMain.handle('hub:linkCode', linkPass)

  ipcMain.handle('hub:team', async (): Promise<TeamSettingSaved> => {
    const s = await loadSettings()
    return { team: s.team ?? null, sources: s.codeSources ?? [] }
  })
  /** Save the team number and GitHub sources together (both checked first). When the sources changed, the full link pass runs once: saving is the user's own action, like the button. */
  ipcMain.handle('hub:setTeam', async (_e, team: number | null, sources: string[]): Promise<TeamSettingSaved> => {
    const checked = checkTeamSetting(team, sources)
    const before = (await loadSettings()).codeSources ?? []
    await saveSettings({ team: checked.team ?? undefined, codeSources: checked.sources })
    return { ...checked, ...(needsLinkPass(before, checked.sources) ? { linkReport: await linkPass() } : {}) }
  })

  /** Read every robot log in this library again with the current describer; appends a `meta` record for each that reads differently. */
  ipcMain.handle('hub:redescribe', async (): Promise<RedescribeReport> => {
    const lib = await open()
    return job('Reading logs again', (j, progress) => redescribe(lib, { describer: describerId(app.getVersion()), describe: describer.describe, cancelled: () => j.cancelled, onProgress: progress }))
  })

  ipcMain.handle('hub:setTag', async (_e, target: TagTarget, field: TagField, value: string) => {
    const goodTarget = ('log' in target && /^[0-9a-f]{64}$/.test(target.log)) || ('day' in target && /^\d{4}-\d{2}-\d{2}$/.test(target.day))
    if (!goodTarget || !['driver', 'place', 'battery', 'robot'].includes(field)) throw new Error('not a tag Hindsight knows')
    const lib = await open()
    await lib.append({ type: 'tag', target, field, value: String(value).trim(), recordedAt: Date.now(), machine: lib.machine })
  })

  ipcMain.handle('hub:readLog', async (_e, path: string) => {
    const lib = await open()
    if (!checkPath(path).startsWith('logs/')) throw new Error('not a log path')
    const info = await lib.store.stat(path)
    if (!info) throw new Error(`${path} is not on this computer`)
    return lib.store.read(path, 0, info.size)
  })

  // ---- Google Drive ----
  ipcMain.handle('hub:driveStatus', async (): Promise<DriveStatus> => {
    const s = await loadSettings()
    const k = keeping(signedIn())
    return { configured: (await googleClient()) !== null, signedIn: signedIn(), teamFolder: s.teamFolder ?? null, keepsSignIn: k.keeps, keepWarning: k.why, lastSync: s.lastSync?.at ?? null }
  })
  ipcMain.handle('hub:driveSignIn', () => signIn())
  ipcMain.handle('hub:driveSignOut', () => signOut())
  ipcMain.handle('hub:setGoogleClient', async (_e, id: string, secret: string) => { await saveSettings({ googleClient: id.trim() ? { id: id.trim(), secret: secret.trim() } : undefined }) })
  ipcMain.handle('hub:driveFolders', async (_e, parentId: string) => (await sourceStore()).folderChoices(String(parentId)))
  ipcMain.handle('hub:setTeamFolder', async (_e, text: string) => {
    const id = folderIdFrom(String(text))
    if (!id) throw new Error('That is not a Drive folder link or id.')
    const folder = await (await sourceStore()).describeFolder(id)
    if (!folder) throw new Error('Drive cannot show that folder to this account (is it a folder you can open?).')
    await saveSettings({ teamFolder: folder, lastSync: undefined })
    return folder
  })

  const driveSource = async (text: string) => {
    const id = folderIdFrom(String(text))
    if (!id) throw new Error('That is not a Drive folder link or id.')
    return driveFolderFiles(await sourceStore(), id, app.getPath('temp'))
  }
  ipcMain.handle('hub:driveIngestPlan', async (_e, text: string) => planIngest(await open(), await driveSource(text)))
  ipcMain.handle('hub:addFromDrive', async (_e, text: string) => runIngest('Reading Drive folder', await driveSource(text)))

  const missingFromTeam = async (lib: LocalLibrary, team: DriveAdapter) => {
    const there = new Map((await team.list('logs')).map((f) => [f.path, f.size]))
    return lib.catalog.all().filter((r) => r.machine === lib.machine && there.get(r.path) !== r.size)
  }
  ipcMain.handle('hub:syncPlan', async (): Promise<SyncPlan> => {
    const lost = await missingFromTeam(await open(), await teamStore())
    return { uploads: lost.length, uploadBytes: lost.reduce((n, r) => n + r.size, 0) }
  })
  ipcMain.handle('hub:sync', async () => {
    const lib = await open()
    const team = await teamStore()
    return job('Syncing', async (j, progress) => {
      const report = await syncWithTeam(lib, team, { cancelled: () => j.cancelled, onProgress: progress })
      await saveSettings({ lastSync: { at: Date.now(), paths: report.remotePaths } })
      return report
    })
  })
  ipcMain.handle('hub:fetchLogs', async (_e, paths: string[]) => {
    const lib = await open()
    const team = await teamStore()
    const wanted = new Set(paths)
    return job('Downloading', (j, progress) => fetchLogs(lib, team, lib.catalog.all().filter((r) => wanted.has(r.path)), { cancelled: () => j.cancelled, onProgress: progress }))
  })

  // ---- The robot ----
  ipcMain.handle('hub:addFromRobot', async (_e, address: string): Promise<RobotResult> => {
    const where = String(address).trim()
    if (!/^[\w.-]+$/.test(where)) throw new Error('That is not a robot address (use 10.TE.AM.2 or roboRIO-TEAM-FRC.local).')
    const idle = await checkRobotIdle(where)
    if (!idle.ok) return { refused: idle.reason }
    const fs = await connectRobotFs(where)
    try {
      const { files, stillWriting } = await robotFiles(fs, { tempRoot: app.getPath('temp') })
      return { report: await runIngest('Reading robot', files), stillWriting }
    } finally { fs.close() }
  })

  ipcMain.handle('hub:updateInfo', () => update)

  app.on('before-quit', () => describer.stop())
}
