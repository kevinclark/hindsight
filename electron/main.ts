/**
 * Hindsight desktop app: the same page as hindsight.html in a window, plus the team's log library (src/hub/).
 * This file owns the window, the single-instance lock and the page's way into the library (hub-ipc.ts).
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerHub } from './hub-ipc.ts'
import { selfUpdates } from '../src/hub/update.ts'

// A test or demo run keeps its settings, library and caches in a folder of its own (before the lock, which is per data folder).
if (process.env.HINDSIGHT_USER_DATA) app.setPath('userData', process.env.HINDSIGHT_USER_DATA)

// One Hindsight per machine: two would append to the same manifest (src/hub/catalog.ts, one writer per file).
const first = app.requestSingleInstanceLock()
if (!first) app.quit()

let window: BrowserWindow | null = null

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400, height: 900, title: 'Hindsight',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // The page is local; every link out opens in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  // One line each to stdout, to tell a navigation from a crashed renderer when the page reloads without being asked.
  window.webContents.on('did-start-navigation', ({ url, isSameDocument, isMainFrame }) => { if (!isSameDocument && isMainFrame) console.log(`did-start-navigation url=${url}`) })
  window.webContents.on('render-process-gone', (_e, details) => console.log(`render-process-gone reason=${details.reason}`))
  window.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault() })
  void window.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  window.on('closed', () => { window = null })
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
if (first) void app.whenReady().then(() => {
  registerHub(() => window)
  createWindow()
  // An installed Windows or Linux build (and a signed Mac one) fetches a newer release in the background and installs it on quit.
  // Anywhere else the page's banner points to the release. A failed check is logged and ignored.
  if (selfUpdates({ isPackaged: app.isPackaged, platform: process.platform, macSigned: __MAC_SIGNED__ })) {
    void import('electron-updater')
      // electron-updater's autoUpdater is a lazy getter Node can't see as a named export of the CommonJS module: read it off the default.
      .then((m) => (m.default ?? m).autoUpdater.checkForUpdatesAndNotify())
      .catch((e) => console.log(`update check failed: ${e instanceof Error ? e.message : String(e)}`))
  }
})
app.on('window-all-closed', () => app.quit())
