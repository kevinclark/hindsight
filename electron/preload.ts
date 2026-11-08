/** What the page may ask the app to do: a small, named set, never Node itself. Types: src/hub/bridge.ts. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** An error from the main process arrives wrapped in Electron's own words; the page shows only what was said. */
const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`hub:${channel}`, ...args).catch((e: Error) => {
  throw new Error(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
})

const CHANNELS = [
  'info', 'library', 'addFromFolder', 'cancel', 'runningJob', 'redescribe', 'lastJob', 'codePlan', 'team', 'setTeam', 'tba', 'setNexusKey', 'nexus', 'linkCode', 'setTag', 'history', 'appendHistory', 'readLog', 'openInAdvantageScope',
  'driveStatus', 'driveSignIn', 'driveSignOut', 'setGoogleClient', 'driveFolders', 'setTeamFolder', 'driveIngestPlan', 'addFromDrive',
  'syncPlan', 'sync', 'fetchLogs', 'addFromRobot', 'updateInfo',
] as const

contextBridge.exposeInMainWorld('hub', {
  ...Object.fromEntries(CHANNELS.map((c) => [c, call(c)])),
  /** The path of a file the user picked or dropped, or '' when it isn't on disk. */
  pathForFile: (file: File): string => { try { return webUtils.getPathForFile(file) } catch { return '' } },
  onProgress: (callback: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => callback(p)
    ipcRenderer.on('hub:progress', listener)
    return () => { ipcRenderer.removeListener('hub:progress', listener) }
  },
})
