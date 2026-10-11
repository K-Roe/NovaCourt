import { app, BrowserWindow, dialog, ipcMain, Menu, session, WebContentsView, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OpenCodeService, validWorkspace } from './openCodeService.cjs'
import { ConversationService } from './conversationService.cjs'
import { PortraitService } from './portraitService.cjs'
import { TerminalService } from './terminalService.cjs'

type PanelWidths = { karl: number; astra: number; nova: number }
type Settings = { panelWidths: PanelWidths }
type ViewRequest = { visible: boolean; rect: { x: number; y: number; width: number; height: number }; zoom: number }
type AstraStatus = { source: 'fixture' | 'chatgpt'; phase: 'loading' | 'open' | 'sign-in-page' | 'offline' | 'error' | 'blocked'; detail: string }

const defaultSettings: Settings = { panelWidths: { karl: 34, astra: 35, nova: 31 } }
const chatGptUrl = 'https://chatgpt.com/'
const fixtureMode = process.env.NC_V2_ASTRA_FIXTURE === '1'
const allowedHosts = new Set(['chatgpt.com', 'auth.openai.com', 'openai.com', 'accounts.google.com', 'appleid.apple.com', 'login.live.com', 'login.microsoftonline.com'])
const views = new Map<string, WebContentsView>()
let mainWindow: BrowserWindow | null = null
let attached = false
let lastBounds: Rectangle | null = null
let novaService: OpenCodeService | null = null
let terminalService: TerminalService | null = null
let portraitService: PortraitService | null = null
let conversationService: ConversationService | null = null
let astraStatus: AstraStatus = fixtureMode
  ? { source: 'fixture', phase: 'loading', detail: 'Loading local fixture' }
  : { source: 'chatgpt', phase: 'loading', detail: 'Loading chatgpt.com' }

if (process.env.NC_V2_USER_DATA) app.setPath('userData', resolve(process.env.NC_V2_USER_DATA))

function settingsPath() { return join(app.getPath('userData'), 'settings.json') }
function validWidths(value: unknown): value is PanelWidths {
  if (!value || typeof value !== 'object') return false
  const widths = value as Record<string, unknown>
  const numbers = [widths.karl, widths.astra, widths.nova]
  return numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 20 && n <= 60) && Math.abs((numbers as number[]).reduce((a, b) => a + b, 0) - 100) < 0.01
}
function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    if (validWidths(parsed.panelWidths)) return { panelWidths: parsed.panelWidths }
  } catch { /* First launch or invalid settings use safe defaults. */ }
  return defaultSettings
}
function saveSettings(value: Settings) {
  const path = settingsPath()
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}
function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return mainWindow !== null && event.sender.id === mainWindow.webContents.id && event.senderFrame === mainWindow.webContents.mainFrame
}
function publishAstraStatus(phase: AstraStatus['phase'], detail: string) {
  astraStatus = { source: fixtureMode ? 'fixture' : 'chatgpt', phase, detail }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('astra:status', astraStatus)
}
function allowedNavigation(rawUrl: string, fixtureUrl: string) {
  if (fixtureMode) return rawUrl === fixtureUrl
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) && !url.username && !url.password
  } catch { return false }
}
function loadedPhase(rawUrl: string): AstraStatus['phase'] {
  if (fixtureMode) return 'open'
  try {
    const url = new URL(rawUrl)
    if (url.hostname === 'auth.openai.com' || /^\/(auth\/login|login|signin)(\/|$)/i.test(url.pathname)) return 'sign-in-page'
  } catch { /* Keep the conservative open state. */ }
  return 'open'
}
function clampView(request: ViewRequest): Rectangle | null {
  if (!mainWindow || !request || typeof request !== 'object' || !request.visible) return null
  const { rect, zoom } = request
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if (zoom < 0.5 || zoom > 3 || rect.width <= 0 || rect.height <= 0) return null
  const { width, height } = mainWindow.getContentBounds()
  const left = Math.max(0, Math.min(width, Math.round(rect.x * zoom)))
  const top = Math.max(0, Math.min(height, Math.round(rect.y * zoom)))
  const right = Math.max(left, Math.min(width, Math.round((rect.x + rect.width) * zoom)))
  const bottom = Math.max(top, Math.min(height, Math.round((rect.y + rect.height) * zoom)))
  if (right - left < 20 || bottom - top < 20) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
function updateAstra(request: ViewRequest) {
  const view = views.get('astra')
  if (!mainWindow || mainWindow.isDestroyed() || !view) return
  const bounds = clampView(request)
  if (!bounds) {
    if (attached) mainWindow.contentView.removeChildView(view)
    attached = false
    lastBounds = null
    return
  }
  view.setBounds(bounds)
  if (!attached) mainWindow.contentView.addChildView(view)
  attached = true
  lastBounds = bounds
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    show: false, backgroundColor: '#100f18', title: 'NovaCourt V2',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  mainWindow = window
  novaService = new OpenCodeService(app.getPath('userData'), (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nova:state', state)
  })
  terminalService = new TerminalService(
    (state) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:state', state) },
    (id, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', { id, data }) },
  )
  portraitService = new PortraitService(app.getPath('userData'), (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('portrait:state', state)
  })
  // The conversation service is constructed with no reference to the terminal or OpenCode services.
  // That is the enforcement for "a discussion message never authorises execution": there is no object
  // graph from a court message to a command, so no sequence of messages can produce one.
  conversationService = new ConversationService(app.getPath('userData'), (messages) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('court:messages', messages)
  })
  const confirmTerminalStop = async (reason: string) => {
    if (!terminalService?.isRunning()) return true
    const choice = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Keep running', 'Stop terminal'], defaultId: 0, cancelId: 0,
      title: 'Stop active terminal?', message: reason,
      detail: 'Commands or OpenCode work running in this terminal will be interrupted.',
    })
    return choice.response === 1
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const fixturePath = resolve(__dirname, '../dist/fixture.html')
  const fixtureUrl = process.env.NC_V2_DEV_URL ? `${process.env.NC_V2_DEV_URL}/fixture.html` : pathToFileURL(fixturePath).toString()
  const partition = fixtureMode ? 'astra-layout-fixture' : 'persist:chatgpt'
  const astraSession = session.fromPartition(partition)
  astraSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const astra = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  views.set('astra', astra)
  astra.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  astra.webContents.on('will-navigate', (event) => {
    if (!allowedNavigation(event.url, fixtureUrl)) { event.preventDefault(); publishAstraStatus('blocked', 'Navigation outside the permitted sign-in sites was blocked') }
  })
  astra.webContents.on('will-redirect', (event) => {
    if (!allowedNavigation(event.url, fixtureUrl)) { event.preventDefault(); publishAstraStatus('blocked', 'Redirect outside the permitted sign-in sites was blocked') }
  })
  astra.webContents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) publishAstraStatus('loading', 'Loading ChatGPT website') })
  astra.webContents.on('did-finish-load', () => {
    const phase = loadedPhase(astra.webContents.getURL())
    publishAstraStatus(phase, fixtureMode ? 'Local layout fixture loaded' : phase === 'sign-in-page' ? 'Sign-in page displayed; account status unverified' : 'Website loaded; account status unverified')
  })
  astra.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      const phase = loadedPhase(url)
      publishAstraStatus(phase, phase === 'sign-in-page' ? 'Sign-in page displayed; account status unverified' : 'Website loaded; account status unverified')
    }
  })
  astra.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    publishAstraStatus(errorCode === -106 ? 'offline' : 'error', errorCode === -106 ? 'Network disconnected; reconnect and retry' : `Website failed to load (network error ${errorCode}); retry`)
  })
  astra.webContents.on('render-process-gone', () => publishAstraStatus('error', 'Website process stopped; retry'))
  void astra.webContents.loadURL(fixtureMode ? fixtureUrl : chatGptUrl)

  ipcMain.handle('settings:read', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return loadSettings() })
  ipcMain.handle('settings:saveWidths', (event, value: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!validWidths(value)) throw new Error('Invalid panel widths')
    const settings = { panelWidths: value }
    saveSettings(settings)
    return settings
  })
  ipcMain.on('astra:bounds', (event, request: ViewRequest) => { if (trustedSender(event)) updateAstra(request) })
  ipcMain.handle('nova:getState', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.snapshot() })
  ipcMain.handle('nova:configure', async (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (terminalService?.isRunning() && input && typeof input === 'object' && 'workspace' in input) {
      const workspace = validWorkspace(input.workspace)
      if (workspace.toLowerCase() !== novaService?.snapshot().config.workspace.toLowerCase()) {
        if (!await confirmTerminalStop('Changing Nova workspace will stop the active terminal.')) return novaService?.snapshot()
        await terminalService.stop()
      }
    }
    return novaService?.configure(input)
  })
  ipcMain.handle('nova:connect', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.connect() })
  ipcMain.handle('nova:startServer', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.startServer() })
  ipcMain.handle('nova:createSession', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.createSession() })
  ipcMain.handle('nova:selectSession', (event, id: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.selectSession(id) })
  ipcMain.handle('nova:chooseModel', (event, id: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.chooseModel(id) })
  ipcMain.handle('nova:send', (event, message: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.send(message) })
  ipcMain.handle('nova:stop', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.stop() })
  ipcMain.handle('nova:refresh', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.refreshSessions() })
  ipcMain.handle('terminal:getState', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return terminalService?.snapshot() })
  ipcMain.handle('terminal:start', (event, mode: unknown, size: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const config = novaService?.snapshot().config
    if (!config || !terminalService) throw new Error('Terminal is unavailable')
    return terminalService.start(mode, config.workspace, config.executablePath, size)
  })
  ipcMain.handle('terminal:stop', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!await confirmTerminalStop('Stop this terminal session?')) return terminalService?.snapshot()
    return terminalService?.stop()
  })
  ipcMain.handle('terminal:restart', async (event, mode: unknown, size: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!await confirmTerminalStop('Restart this terminal session?')) return terminalService?.snapshot()
    await terminalService?.stop()
    const config = novaService?.snapshot().config
    if (!config || !terminalService) throw new Error('Terminal is unavailable')
    return terminalService.start(mode, config.workspace, config.executablePath, size)
  })
  ipcMain.handle('terminal:clear', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return terminalService?.clear() })
  ipcMain.on('terminal:write', (event, id: unknown, data: unknown) => { if (trustedSender(event)) { try { terminalService?.write(id, data) } catch { /* Ignore stale or invalid input. */ } } })
  ipcMain.on('terminal:resize', (event, id: unknown, size: unknown) => { if (trustedSender(event)) { try { terminalService?.resize(id, size) } catch { /* Ignore stale or invalid dimensions. */ } } })
  ipcMain.handle('court:messages', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return conversationService?.snapshot() })
  ipcMain.handle('court:append', (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    const result = conversationService.append(input as Parameters<ConversationService['append']>[0])
    if (!result.ok) throw new Error(result.reason)
    return result.message
  })
  ipcMain.handle('court:forward', (event, id: unknown, recipient: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    if (typeof id !== 'string') throw new Error('No such message')
    const original = conversationService.snapshot().find((message) => message.id === id)
    if (!original) throw new Error('No such message')
    // The original is never modified. A forward is a new message that names the one it came from.
    const result = conversationService.append({
      sender: original.sender,
      recipient,
      text: original.text,
      source: 'manual',
      caseRef: original.caseRef,
      forwardedFrom: original.id
    })
    if (!result.ok) throw new Error(result.reason)
    return result.message
  })
  ipcMain.handle('court:delivery', (event, id: unknown, delivery: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    const result = conversationService.markDelivery(id, delivery)
    if (!result.ok) throw new Error(result.reason)
    return conversationService.snapshot()
  })
  ipcMain.handle('portrait:list', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return portraitService?.snapshot() })
  ipcMain.handle('portrait:image', (event, participant: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const found = portraitService?.read(participant)
    // Served as a data URL rather than a file:// path so the renderer never learns a filesystem
    // location and never gains a path it could resolve itself.
    return found ? `data:${found.record.mime};base64,${found.data.toString('base64')}` : null
  })
  ipcMain.handle('portrait:save', (event, participant: unknown, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    const record = portraitService.save(participant, payload)
    const stored = portraitService.read(participant)
    return { ...record, url: stored ? `data:${record.mime};base64,${stored.data.toString('base64')}` : null }
  })
  ipcMain.handle('portrait:framing', (event, participant: unknown, framing: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    return portraitService.setFraming(participant, framing)
  })
  ipcMain.handle('portrait:reset', (event, participant: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    return portraitService.reset(participant)
  })
  ipcMain.handle('astra:readStatus', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return astraStatus })
  ipcMain.on('astra:retry', (event) => {
    if (!trustedSender(event)) return
    const view = views.get('astra')
    if (!view || view.webContents.isDestroyed()) return
    publishAstraStatus('loading', fixtureMode ? 'Loading local fixture' : 'Loading chatgpt.com')
    void view.webContents.loadURL(fixtureMode ? fixtureUrl : chatGptUrl)
  })
  if (process.env.NC_V2_TEST === '1') ipcMain.handle('test:viewBounds', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return { bounds: lastBounds, attached, registered: views.has('astra') } })

  window.on('resize', () => window.webContents.send('window:resize'))
  window.on('close', () => updateAstra({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, zoom: 1 }))
  window.on('closed', () => {
    terminalService?.close()
    terminalService = null
    portraitService?.close()
    portraitService = null
    conversationService?.close()
    conversationService = null
    novaService?.close()
    novaService = null
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
    views.clear()
    mainWindow = null
  })
  window.once('ready-to-show', () => window.show())
  if (process.env.NC_V2_DEV_URL) void window.loadURL(process.env.NC_V2_DEV_URL)
  else if (existsSync(resolve(__dirname, '../dist/index.html'))) void window.loadFile(resolve(__dirname, '../dist/index.html'))
  else throw new Error('Renderer build missing. Run npm run build before npm start.')
  void novaService.connect()
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
