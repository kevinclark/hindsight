/** What the page may ask the app to do: a small, named set, never Node itself. Types: src/hub/bridge.ts. */
import { contextBridge, ipcRenderer } from 'electron'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`hub:${channel}`, ...args)

contextBridge.exposeInMainWorld('hub', {
  info: call('info'),
  library: call('library'),
  addFromFolder: call('addFromFolder'),
  cancel: call('cancel'),
  setTag: call('setTag'),
  readLog: call('readLog'),
  onProgress: (callback: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => callback(p)
    ipcRenderer.on('hub:progress', listener)
    return () => { ipcRenderer.removeListener('hub:progress', listener) }
  },
})
