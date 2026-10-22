/** The page's way into the library. Each handler is thin: the work is in src/hub/. */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { LocalLibrary, readJson, writeJson } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles, type IngestReport } from '../src/hub/ingest.ts'
import { checkPath } from '../src/hub/adapter.ts'
import type { LibrarySnapshot } from '../src/hub/bridge.ts'
import type { TagField, TagTarget } from '../src/hub/types.ts'
import { Describer } from './describer.ts'
import { loadSettings } from './settings.ts'

export function registerHub(window: () => BrowserWindow | null): void {
  const describer = new Describer()
  let library: Promise<LocalLibrary> | null = null
  let running: { cancelled: boolean } | null = null
  const open = () => (library ??= loadSettings().then((s) => LocalLibrary.open(s.libraryDir, s.machineId)))
  const seenFile = () => join(app.getPath('userData'), 'seen.json')
  const send = (channel: string, payload: unknown) => window()?.webContents.send(channel, payload)

  ipcMain.handle('hub:info', async () => {
    const lib = await open()
    return { version: app.getVersion(), machineId: lib.machine, libraryDir: lib.root }
  })

  ipcMain.handle('hub:library', async (): Promise<LibrarySnapshot> => {
    const lib = await open()
    const entries = lib.catalog.entries()
    await Promise.all(entries.map(async (e) => { e.local = (await stat(lib.store.at(e.record.path)).catch(() => null)) !== null }))
    return { entries, skipped: lib.catalog.skipped, libraryDir: lib.root, machineId: lib.machine }
  })

  ipcMain.handle('hub:addFromFolder', async (): Promise<IngestReport | null> => {
    if (running) throw new Error('Another import is running')
    const picked = process.env.HINDSIGHT_PICK_FOLDER ?? (await dialog.showOpenDialog({ title: 'Add logs from a folder', properties: ['openDirectory'] })).filePaths[0]
    if (!picked) return null
    const lib = await open()
    const seenPath = seenFile()
    const seen = new Map(Object.entries(await readJson<Record<string, string>>(seenPath, {})))
    const job = (running = { cancelled: false })
    try {
      const files = await localFolderFiles(picked)
      const report = await ingest(lib, files, {
        describe: describer.describe,
        seen,
        cancelled: () => job.cancelled,
        onProgress: (done, total, current) => send('hub:progress', { job: 'folder', done, total, current }),
      })
      await writeJson(seenPath, Object.fromEntries(seen))
      return report
    } finally { running = null }
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
    if (!info) throw new Error(`${path} is not on this machine`)
    return lib.store.read(path, 0, info.size)
  })

  app.on('before-quit', () => describer.stop())
}
