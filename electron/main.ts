/**
 * Hindsight desktop app: the same page as hindsight.html in a window, plus the team's log library (src/hub/).
 * This file owns the window, the single-instance lock and the page's way into the library (hub-ipc.ts).
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerHub } from './hub-ipc.ts'

// One Hindsight per machine: two would append to the same manifest (src/hub/manifest.ts, one writer per file).
if (!app.requestSingleInstanceLock()) app.quit()

let window: BrowserWindow | null = null

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400, height: 900, title: 'Hindsight',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // The page is local; every link out opens in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault() })
  void window.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  window.on('closed', () => { window = null })
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
// A test or demo run keeps its settings, library and caches in a folder of its own.
if (process.env.HINDSIGHT_USER_DATA) app.setPath('userData', process.env.HINDSIGHT_USER_DATA)

void app.whenReady().then(() => {
  registerHub(() => window)
  createWindow()
})
app.on('window-all-closed', () => app.quit())
