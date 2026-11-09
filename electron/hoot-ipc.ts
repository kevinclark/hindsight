/**
 * The Devices tab's way to .hoot files (ADR 13): CTRE's licence, finding or downloading owlet, reading a log's .hoot files.
 * Its jobs run on their own runner (one at a time, logged to the same jobs.log): they never touch the library's manifest,
 * so a sync running is no reason to refuse opening the tab.
 */
import { app, ipcMain } from 'electron'
import { readdirSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkPath } from '../src/hub/adapter.ts'
import type { LocalLibrary } from '../src/hub/library-store.ts'
import { JobRunner, type JobProgress, type ProgressFn } from '../src/hub/jobs.ts'
import { advantageScopeOwletFolder, compliancyOf, findOwlet, platformKey, busOf, type FoundOwlet } from '../src/hoot/owlet.ts'
import { readHoot } from '../src/hoot/read-hoot.ts'
import { downloadOwlet } from '../src/hoot/download.ts'
import type { HootFile, HootReadReport, HootStatus } from '../src/hoot/types.ts'
import type { JobLog } from './job-log.ts'
import { loadSettings, saveSettings } from './settings.ts'

export function registerHoot(o: { open: () => Promise<LocalLibrary>; jobLog: JobLog; send: (channel: string, payload: unknown) => void }): void {
  const jobs = new JobRunner(Date.now, o.jobLog, app.getVersion())
  let abort: AbortController | null = null
  const job = <T>(name: string, work: (progress: ProgressFn, signal: AbortSignal, log: (line: string) => void) => Promise<T>): Promise<T> => {
    const mine = new AbortController()
    return jobs.run(name, (j, progress) => { abort = mine; return work(progress, mine.signal, j.log) }, (p) => o.send('hub:hootProgress', p))
      .finally(() => { if (abort === mine) abort = null })
  }

  const ownFolder = () => join(app.getPath('userData'), 'owlet')
  // A test run points AdvantageScope's folder elsewhere (an empty folder hides Kevin's cache without touching it).
  const ascopeFolder = () => process.env.HINDSIGHT_ASCOPE_OWLET_DIR
    ?? advantageScopeOwletFolder(process.platform, { home: app.getPath('home'), appData: process.env.APPDATA, xdgConfig: process.env.XDG_CONFIG_HOME })
  const list = (dir: string) => { try { return readdirSync(dir) } catch { return [] } }
  const owletFor = (compliancy: number): FoundOwlet | null => findOwlet(compliancy, [
    { dir: ownFolder(), where: 'hindsight' },
    ...((): { dir: string; where: 'advantagescope' }[] => { const d = ascopeFolder(); return d ? [{ dir: d, where: 'advantagescope' }] : [] })(),
  ], list)
  const licence = async () => (await loadSettings()).ctreLicence !== undefined
  const needLicence = async () => { if (!(await licence())) throw new Error("Accept CTRE's licence first: owlet is CTRE's software.") }

  /** The .hoot files attached to a robot log (library path), each with what this computer holds and can read it with. */
  async function filesFor(lib: LocalLibrary, logPath: string): Promise<(HootFile & { sha256: string })[]> {
    if (!checkPath(logPath).startsWith('logs/')) throw new Error('not a log path')
    const entry = lib.catalog.entries().find((e) => e.record.path === logPath)
    return Promise.all((entry?.attached.hoot ?? []).map(async (r) => {
      const name = r.path.split('/').pop()!
      const compliancy = await formatOf(lib.store.at(r.path))
      const owlet = compliancy === null ? null : owletFor(compliancy)
      return { path: r.path, sha256: r.sha256, name, bus: busOf(name), size: r.size, held: compliancy !== null, compliancy, owlet: owlet && { version: owlet.version, where: owlet.where } }
    }))
  }

  ipcMain.handle('hub:hootFor', async (_e, logPath: string): Promise<HootStatus> => {
    const files = (await filesFor(await o.open(), String(logPath))).map(({ sha256: _, ...f }) => f)
    return { files, licence: await licence(), canDownload: platformKey(process.platform, process.arch) !== null }
  })

  ipcMain.handle('hub:acceptCtreLicence', async () => { await saveSettings({ ctreLicence: { acceptedAt: Date.now() } }) })

  ipcMain.handle('hub:getOwlet', async (_e, compliancy: number) => {
    await needLicence()
    if (!Number.isInteger(compliancy) || compliancy < 0 || compliancy > 255) throw new Error('not a .hoot format')
    return job("Getting CTRE's converter (owlet)", async (progress, signal, log) => {
      progress(0, 1, 'owlet', { step: "Asking CTRE's server which owlet reads these files" })
      const got = await downloadOwlet({
        compliancy, platform: process.platform, arch: process.arch, dir: ownFolder(), signal, log,
        onBytes: (done, total) => progress(0, 1, 'owlet', { file: { done, total }, transfer: true, ...(total ? {} : { step: `${(done / 1e6).toFixed(1)} MB so far` }) }),
      })
      progress(1, 1, 'owlet')
      return { version: got.version, compliancy: got.compliancy }
    })
  })

  ipcMain.handle('hub:readHoots', async (_e, logPath: string): Promise<HootReadReport> => {
    await needLicence()
    const lib = await o.open()
    const files = (await filesFor(lib, String(logPath))).filter((f) => f.held)
    return job('Reading device logs (.hoot)', async (progress, signal, log) => {
      const report: HootReadReport = { readings: [], problems: [] }
      for (const [i, f] of files.entries()) {
        if (signal.aborted) break
        const owlet = f.compliancy === null ? null : owletFor(f.compliancy)
        if (!owlet) { report.problems.push({ file: f.name, why: `No owlet on this computer reads this file (format ${f.compliancy}).` }); continue }
        progress(i, files.length, f.name, { file: { done: 0, total: f.size } })
        try {
          const r = await readHoot({
            owlet, argv: [owlet.path], hootPath: lib.store.at(f.path), fileName: f.name, sha256: f.sha256,
            // Not `cache/hoot`: on a case-insensitive disk (every Mac by default) that is inside Chromium's own Cache folder.
            cacheDir: join(app.getPath('userData'), 'hoot-cache'), tempRoot: app.getPath('temp'), signal, log: (l) => log(l),
            onPercent: (p) => progress(i, files.length, f.name, { file: { done: Math.round((p / 100) * f.size), total: f.size } }),
          })
          const { cached: _, ...reading } = r
          report.readings.push(reading)
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          log(`${f.name}: ${why}`)
          report.problems.push({ file: f.name, why })
        }
      }
      progress(files.length, files.length, '')
      return report
    })
  })

  ipcMain.handle('hub:hootCancel', () => { abort?.abort(); jobs.cancel() })
  ipcMain.handle('hub:hootRunning', (): JobProgress | null => jobs.current())
  // Quitting stops owlet: its scratch export is removed by the read that started it.
  app.on('before-quit', () => abort?.abort())
}

/** The format byte of a .hoot on this computer, or null when it isn't here. */
async function formatOf(path: string): Promise<number | null> {
  const fh = await openFile(path).catch(() => null)
  if (!fh) return null
  try {
    const head = new Uint8Array(80)
    const { bytesRead } = await fh.read(head, 0, 80, 0)
    return compliancyOf(head.subarray(0, bytesRead))
  } finally { await fh.close() }
}
