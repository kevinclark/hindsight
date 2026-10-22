/** What the page may ask the app to do: a small, named set, never Node itself. Types: src/hub/bridge.ts. */
import { contextBridge, ipcRenderer } from 'electron'

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`hub:${channel}`, ...args)

contextBridge.exposeInMainWorld('hub', {
  info: call('info'),
})
