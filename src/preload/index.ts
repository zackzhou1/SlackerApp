import { contextBridge, ipcRenderer } from 'electron'

// Expose a safe, typed API to the renderer
contextBridge.exposeInMainWorld('api', {
  send: (channel: string, data?: unknown) =>
    ipcRenderer.send(channel, data),

  invoke: (channel: string, data?: unknown) =>
    ipcRenderer.invoke(channel, data),

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },

  off: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  }
})
