/** The page's way into the library. Each handler is thin: the work is in src/hub/. */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { LocalLibrary, readJson, writeJson } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles, planIngest, type IngestReport, type SourceFile } from '../src/hub/ingest.ts'
import { checkPath } from '../src/hub/adapter.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { driveFolderFiles, folderIdFrom } from '../src/hub/drive-source.ts'
import { fetchLogs, syncWithTeam } from '../src/hub/sync.ts'
import { checkRobotIdle, connectRobotFs, robotFiles } from '../src/hub/robot.ts'
import { checkForUpdate } from '../src/hub/update.ts'
import type { DriveStatus, LibrarySnapshot, RobotResult, SyncPlan } from '../src/hub/bridge.ts'
import type { TagField, TagTarget } from '../src/hub/types.ts'
import { Describer } from './describer.ts'
import { driveToken, googleClient, keeping, signIn, signOut, signedIn } from './google-auth.ts'
import { loadSettings, saveSettings } from './settings.ts'

export function registerHub(window: () => BrowserWindow | null): void {
  const describer = new Describer()
  let library: Promise<LocalLibrary> | null = null
  let running: { cancelled: boolean } | null = null
  const open = () => (library ??= loadSettings().then((s) => LocalLibrary.open(s.libraryDir, s.machineId)))
  const seenFile = () => join(app.getPath('userData'), 'seen.json')
  const send = (channel: string, payload: unknown) => window()?.webContents.send(channel, payload)

  // The one request to the public repo's releases, made once on start.
  const update = checkForUpdate(app.getVersion())

  /** One job at a time (an import, a sync, a download): they share the library's manifest and the user's attention. */
  async function job<T>(name: string, work: (job: { cancelled: boolean }, progress: (done: number, total: number, current: string) => void) => Promise<T>): Promise<T> {
    if (running) throw new Error('Another job is running. Wait for it or stop it first.')
    const mine = (running = { cancelled: false })
    try { return await work(mine, (done, total, current) => send('hub:progress', { job: name, done, total, current })) } finally { running = null }
  }

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
      e.local = (await stat(lib.store.at(e.record.path)).catch(() => null)) !== null
      e.shared = shared.has(e.record.path)
    }))
    return { entries, skipped: lib.catalog.skipped, libraryDir: lib.root, machineId: lib.machine }
  })

  ipcMain.handle('hub:addFromFolder', async (): Promise<IngestReport | null> => {
    const picked = process.env.HINDSIGHT_PICK_FOLDER ?? (await dialog.showOpenDialog({ title: 'Add logs from a folder', properties: ['openDirectory'] })).filePaths[0]
    return picked ? runIngest('Reading folder', await localFolderFiles(picked)) : null
  })

  ipcMain.handle('hub:cancel', () => { if (running) running.cancelled = true })

  ipcMain.handle('hub:setTag', async (_e, target: TagTarget, field: TagField, value: string) => {
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
    const k = keeping()
    return { configured: (await googleClient()) !== null, signedIn: await signedIn(), teamFolder: s.teamFolder ?? null, keepsSignIn: k.keeps, keepWarning: k.why, lastSync: s.lastSync?.at ?? null }
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
    try { return { report: await runIngest('Reading robot', await robotFiles(fs, { tempRoot: app.getPath('temp') })) } } finally { fs.close() }
  })

  ipcMain.handle('hub:updateInfo', () => update)

  app.on('before-quit', () => describer.stop())
}
