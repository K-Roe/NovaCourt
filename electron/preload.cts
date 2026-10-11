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
  getNovaState: () => ipcRenderer.invoke('nova:getState'),
  onNovaState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('nova:state', listener)
    return () => ipcRenderer.removeListener('nova:state', listener)
  },
  configureNova: (input: unknown) => ipcRenderer.invoke('nova:configure', input),
  connectNova: () => ipcRenderer.invoke('nova:connect'),
  startNovaServer: () => ipcRenderer.invoke('nova:startServer'),
  createNovaSession: () => ipcRenderer.invoke('nova:createSession'),
  selectNovaSession: (id: unknown) => ipcRenderer.invoke('nova:selectSession', id),
  chooseNovaModel: (id: unknown) => ipcRenderer.invoke('nova:chooseModel', id),
  sendNovaMessage: (message: unknown) => ipcRenderer.invoke('nova:send', message),
  stopNova: () => ipcRenderer.invoke('nova:stop'),
  refreshNova: () => ipcRenderer.invoke('nova:refresh'),
  getTerminalState: () => ipcRenderer.invoke('terminal:getState'),
  onTerminalState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('terminal:state', listener)
    return () => ipcRenderer.removeListener('terminal:state', listener)
  },
  onTerminalData: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  startTerminal: (mode: unknown, size: unknown) => ipcRenderer.invoke('terminal:start', mode, size),
  stopTerminal: () => ipcRenderer.invoke('terminal:stop'),
  restartTerminal: (mode: unknown, size: unknown) => ipcRenderer.invoke('terminal:restart', mode, size),
  clearTerminal: () => ipcRenderer.invoke('terminal:clear'),
  getCourtMessages: () => ipcRenderer.invoke('court:messages'),
  onCourtMessages: (callback: (messages: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, messages: unknown) => callback(messages)
    ipcRenderer.on('court:messages', listener)
    return () => ipcRenderer.removeListener('court:messages', listener)
  },
  appendCourtMessage: (input: unknown) => ipcRenderer.invoke('court:append', input),
  forwardCourtMessage: (id: unknown, recipient: unknown) => ipcRenderer.invoke('court:forward', id, recipient),
  markCourtDelivery: (id: unknown, delivery: unknown) => ipcRenderer.invoke('court:delivery', id, delivery),
  getPortraits: () => ipcRenderer.invoke('portrait:list'),
  onPortraitState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('portrait:state', listener)
    return () => ipcRenderer.removeListener('portrait:state', listener)
  },
  readPortraitImage: (participant: unknown) => ipcRenderer.invoke('portrait:image', participant),
  savePortrait: (participant: unknown, payload: unknown) => ipcRenderer.invoke('portrait:save', participant, payload),
  framePortrait: (participant: unknown, framing: unknown) => ipcRenderer.invoke('portrait:framing', participant, framing),
  resetPortrait: (participant: unknown) => ipcRenderer.invoke('portrait:reset', participant),
  writeTerminal: (id: unknown, data: unknown) => ipcRenderer.send('terminal:write', id, data),
  resizeTerminal: (id: unknown, size: unknown) => ipcRenderer.send('terminal:resize', id, size),
  testViewBounds: () => ipcRenderer.invoke('test:viewBounds')
})
