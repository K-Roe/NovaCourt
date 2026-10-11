import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('novaCourt', {
  readSettings: () => ipcRenderer.invoke('settings:read'),
  saveWidths: (value: unknown) => ipcRenderer.invoke('settings:saveWidths', value),
  setAstraBounds: (request: unknown) => ipcRenderer.send('astra:bounds', request),
  onWindowResize: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('window:resize', listener)
    return () => ipcRenderer.removeListener('window:resize', listener)
  },
  readAstraStatus: () => ipcRenderer.invoke('astra:readStatus'),
  onAstraStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('astra:status', listener)
    return () => ipcRenderer.removeListener('astra:status', listener)
  },
  retryAstra: () => ipcRenderer.send('astra:retry'),
  testViewBounds: () => ipcRenderer.invoke('test:viewBounds')
})
