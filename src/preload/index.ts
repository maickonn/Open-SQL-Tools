/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcEventMap, PreloadApi } from '@shared/ipc'
import { SESSION_PORT_CHANNEL } from '@shared/ipc'

const api: PreloadApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: IpcEventMap[typeof event]): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)

// MessagePorts cannot cross contextBridge; forward them to the page with window.postMessage.
ipcRenderer.on(SESSION_PORT_CHANNEL, (e, payload: { sessionId: string }) => {
  window.postMessage({ type: 'ost:session-port', sessionId: payload.sessionId }, '*', e.ports)
})
