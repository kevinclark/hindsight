import { app, ipcMain, type BrowserWindow } from 'electron'

export function registerHub(_window: () => BrowserWindow | null): void {
  ipcMain.handle('hub:info', () => ({ version: app.getVersion() }))
}
