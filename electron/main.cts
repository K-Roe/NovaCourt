import { app, BrowserWindow, ipcMain, Menu, session, WebContentsView, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
    views.clear()
    mainWindow = null
  })
  window.once('ready-to-show', () => window.show())
  if (process.env.NC_V2_DEV_URL) void window.loadURL(process.env.NC_V2_DEV_URL)
  else if (existsSync(resolve(__dirname, '../dist/index.html'))) void window.loadFile(resolve(__dirname, '../dist/index.html'))
  else throw new Error('Renderer build missing. Run npm run build before npm start.')
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
