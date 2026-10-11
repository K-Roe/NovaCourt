import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { getNovaPersonality, buildDiscussionSystem, invalidatePersonalityCache } from './novaPersonality.cjs'

type Connection = 'disconnected' | 'connecting' | 'connected' | 'error'
type Config = { endpoint: string; executablePath: string; workspace: string; sessionId: string | null; modelId: string | null }
type Session = { id: string; title: string; directory: string; safe: boolean; updated: number }
type Message = { id: string; role: 'user' | 'assistant'; text: string; created: number; tools: { name: string; status: string }[]; error?: string }
type Model = { id: string; name: string; providerID: string; modelID: string }
export type NovaState = { connection: Connection; error: string | null; version: string | null; installedVersion: string | null; executableFound: boolean; config: Config; sessions: Session[]; messages: Message[]; models: Model[]; busy: boolean; deliveryUncertain: boolean }

const denyAll = [{ permission: '*', pattern: '*', action: 'deny' }] as const
const sessionPattern = /^ses[\w-]{1,128}$/
const maxText = 20_000

function defaultExecutable() {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
  return '/usr/local/bin/opencode'
}
function cleanError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'fetch failed') return 'Cannot reach OpenCode. Start a local server or check the endpoint in Nova settings.'
  return message.replace(/https?:\/\/[^\s]+/g, '[local endpoint]').slice(0, 240)
}
function validEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a loopback HTTP endpoint')
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Endpoint must be http://127.0.0.1:<port>/')
  return url.origin
}
export function validWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose an absolute repository path')
  const path = realpathSync(value)
  if (!statSync(path).isDirectory() || !existsSync(join(path, '.git'))) throw new Error('Workspace must be an existing Git repository')
  const root = realpathSync(join(homedir(), 'repos'))
  const subpath = relative(root, path)
  if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('Workspace must be inside your repos directory')
  return path
}
export function validExecutable(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose an absolute OpenCode executable path')
  const path = realpathSync(value)
  if (!statSync(path).isFile() || (process.platform === 'win32' && basename(path).toLowerCase() !== 'opencode.exe')) throw new Error('Choose the OpenCode .exe file')
  return path
}
function safeSession(value: unknown, toolIds: string[]): boolean {
  if (!value || typeof value !== 'object') return false
  const rules = (value as { permission?: unknown }).permission
  if (!Array.isArray(rules) || !toolIds.length) return false
  if (rules.some((rule) => !rule || rule.action !== 'deny' || rule.pattern !== '*' || typeof rule.permission !== 'string')) return false
  return toolIds.every((id) => {
    const matching = rules.filter((rule) => rule && (rule.permission === '*' || rule.permission === id) && rule.pattern === '*')
    return matching.at(-1)?.action === 'deny'
  })
}
function parseSession(value: any, workspace: string, toolIds: string[]): Session | null {
  if (!value || typeof value.id !== 'string' || !sessionPattern.test(value.id) || typeof value.directory !== 'string') return null
  if (resolve(value.directory).toLowerCase() !== resolve(workspace).toLowerCase()) return null
  return { id: value.id, title: typeof value.title === 'string' ? value.title : 'Untitled session', directory: value.directory, safe: safeSession(value, toolIds), updated: Number(value.time?.updated) || 0 }
}
function parseMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value.slice(-100).flatMap((entry: any) => {
    const info = entry?.info
    if (!info || (info.role !== 'user' && info.role !== 'assistant') || typeof info.id !== 'string') return []
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    const text = parts.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').slice(0, maxText)
    const tools = parts.filter((part: any) => part?.type === 'tool').map((part: any) => ({ name: String(part.tool || 'tool').slice(0, 80), status: String(part.state?.status || 'unknown').slice(0, 40) }))
    const error = info.error ? String(info.error.data?.message || info.error.name || 'OpenCode response error').slice(0, 240) : undefined
    return [{ id: info.id, role: info.role, text, created: Number(info.time?.created) || 0, tools, ...(error ? { error } : {}) }]
  })
}

export class OpenCodeService {
  private state: NovaState
  private owned: ChildProcess | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private activityTimer: ReturnType<typeof setInterval> | null = null
  private eventAbort: AbortController | null = null
  private closed = false
  private refreshing = false
  private pendingUntil = 0
  private toolIds: string[] = []
  private callback: (state: NovaState) => void

  constructor(private readonly dataPath: string, callback: (state: NovaState) => void) {
    this.callback = callback
    const fallback: Config = { endpoint: 'http://127.0.0.1:4096', executablePath: defaultExecutable(), workspace: process.cwd(), sessionId: null, modelId: null }
    let config = fallback
    try {
      const saved = JSON.parse(readFileSync(join(dataPath, 'nova.json'), 'utf8'))
      config = { endpoint: validEndpoint(saved.endpoint), executablePath: typeof saved.executablePath === 'string' ? saved.executablePath : fallback.executablePath, workspace: typeof saved.workspace === 'string' ? saved.workspace : fallback.workspace, sessionId: typeof saved.sessionId === 'string' && sessionPattern.test(saved.sessionId) ? saved.sessionId : null, modelId: typeof saved.modelId === 'string' ? saved.modelId : null }
    } catch { /* First launch or invalid config. */ }
    const installedVersion = this.detectVersion(config.executablePath)
    this.state = { connection: 'disconnected', error: null, version: null, installedVersion, executableFound: !!installedVersion, config, sessions: [], messages: [], models: [], busy: false, deliveryUncertain: false }
  }
  snapshot(): NovaState { return structuredClone(this.state) }
  private emit() { if (!this.closed) this.callback(this.snapshot()) }
  private persist() {
    const path = join(this.dataPath, 'nova.json')
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state.config, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  }
  private detectVersion(path: string): string | null {
    try { return execFileSync(path, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().match(/\d+\.\d+\.\d+/)?.[0] || null } catch { return null }
  }
  configure(input: unknown) {
    if (!input || typeof input !== 'object') throw new Error('Invalid OpenCode settings')
    const data = input as Record<string, unknown>
    const endpoint = validEndpoint(data.endpoint)
    const executablePath = typeof data.executablePath === 'string' ? data.executablePath.trim() : ''
    if (!isAbsolute(executablePath)) throw new Error('Choose an absolute OpenCode executable path')
    const workspace = validWorkspace(data.workspace)
    const previous = this.state.config
    this.disconnect()
    this.state.config = { endpoint, executablePath, workspace, sessionId: previous.workspace.toLowerCase() === workspace.toLowerCase() ? previous.sessionId : null, modelId: previous.modelId }
    this.state.installedVersion = this.detectVersion(executablePath)
    this.state.executableFound = !!this.state.installedVersion
    this.state.error = null
    invalidatePersonalityCache()
    this.persist()
    this.emit()
    return this.snapshot()
  }
  private async request(path: string, init?: RequestInit, timeout = 8000): Promise<any> {
    const url = new URL(path, `${this.state.config.endpoint}/`)
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/json', ...(init?.headers || {}) } })
    if (!response.ok) throw new Error(`OpenCode returned HTTP ${response.status} for ${url.pathname}`)
    if (response.status === 204) return null
    return response.json()
  }
  private path(path: string) { return `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(this.state.config.workspace)}` }
  private async verifyApi() {
    const doc = await this.request('/doc', undefined, 12000)
    const create = doc?.paths?.['/session']?.post?.requestBody?.content?.['application/json']?.schema?.properties
    const prompt = doc?.paths?.['/session/{sessionID}/prompt_async']?.post?.requestBody?.content?.['application/json']?.schema?.properties
    if (!create?.permission || !prompt?.tools || !doc?.paths?.['/session/{sessionID}/abort']?.post || !doc?.paths?.['/event']?.get) throw new Error('This OpenCode server lacks required M3 safety or session APIs')
  }
  async connect() {
    if (this.closed) return
    this.state.connection = 'connecting'; this.state.error = null; this.emit()
    try {
      this.state.config.workspace = validWorkspace(this.state.config.workspace)
      const health = await this.request('/global/health')
      if (health?.healthy !== true || typeof health.version !== 'string') throw new Error('Endpoint is not a healthy OpenCode server')
      await this.verifyApi()
      this.state.version = health.version
      this.state.connection = 'connected'
      await this.refreshToolIds()
      await this.refreshModels()
      await this.refreshSessions()
      this.beginEvents()
      this.beginPolling()
      this.emit()
    } catch (error) {
      this.state.connection = 'error'; this.state.error = cleanError(error); this.emit()
      this.beginPolling()
    }
    return this.snapshot()
  }
  private async refreshModels(autoSelect = true) {
    const providers = await this.request(this.path('/provider'), undefined, 12000)
    this.state.models = (providers?.all || []).filter((provider: any) => ['opencode', 'openrouter'].includes(provider.id) && providers.connected?.includes(provider.id)).flatMap((provider: any) => Object.values(provider.models || {}).filter((model: any) => typeof model.id === 'string' && /(-free|:free)$/.test(model.id) && model.cost?.input === 0 && model.cost?.output === 0).map((model: any) => ({ id: `${provider.id}:${model.id}`, name: `${provider.name || provider.id} · ${model.name || model.id}`, providerID: provider.id, modelID: model.id }))).sort((a: Model, b: Model) => a.name.localeCompare(b.name))
    if (!this.state.models.some((model) => model.id === this.state.config.modelId)) this.state.config.modelId = autoSelect && this.state.config.modelId === null ? this.state.models.find((model) => model.id === 'openrouter:poolside/laguna-s-2.1:free')?.id || this.state.models[0]?.id || null : null
    this.persist()
  }
  private async refreshToolIds() {
    const ids = await this.request(this.path('/experimental/tool/ids'))
    if (!Array.isArray(ids) || !ids.length || ids.some((tool) => typeof tool !== 'string' || !tool)) throw new Error('Unable to verify available OpenCode tools')
    this.toolIds = ids
  }
  async refreshSessions() {
    if (this.state.connection !== 'connected' || this.refreshing) return this.snapshot()
    this.refreshing = true
    try {
      const sessions = await this.request(this.path('/session?limit=100'))
      this.state.sessions = Array.isArray(sessions) ? sessions.map((item) => parseSession(item, this.state.config.workspace, this.toolIds)).filter(Boolean) as Session[] : []
      if (this.state.config.sessionId && !this.state.sessions.some((session) => session.id === this.state.config.sessionId)) this.state.config.sessionId = null
      await this.refreshActivity()
      this.persist(); this.emit()
    } finally { this.refreshing = false }
    return this.snapshot()
  }
  private async refreshActivity() {
    const id = this.state.config.sessionId
    if (!id || this.state.connection !== 'connected') { this.state.messages = []; this.state.busy = false; return }
    const [messages, statuses] = await Promise.all([this.request(this.path(`/session/${encodeURIComponent(id)}/message?limit=100`)), this.request(this.path('/session/status'))])
    this.state.messages = parseMessages(messages)
    this.state.busy = statuses?.[id]?.type === 'busy' || statuses?.[id]?.type === 'retry' || Date.now() < this.pendingUntil
    if (!this.state.busy && this.state.messages.length) this.state.deliveryUncertain = false
  }
  async createSession() {
    this.requireConnected()
    const created = await this.request(this.path('/session'), { method: 'POST', body: JSON.stringify({ title: 'NovaCourt discussion', permission: denyAll }) })
    const session = parseSession(created, this.state.config.workspace, this.toolIds)
    if (!session?.safe) throw new Error('OpenCode did not confirm chat-only session permissions')
    this.state.config.sessionId = session.id; this.state.messages = []; this.state.busy = false; this.persist()
    await this.refreshSessions()
    return this.snapshot()
  }
  async selectSession(id: unknown) {
    this.requireConnected()
    if (typeof id !== 'string' || !sessionPattern.test(id) || !this.state.sessions.some((session) => session.id === id)) throw new Error('Select a session in the active workspace')
    this.state.config.sessionId = id; this.state.deliveryUncertain = false; this.persist()
    await this.refreshActivity(); this.emit()
    return this.snapshot()
  }
  async chooseModel(id: unknown) {
    if (typeof id !== 'string' || !this.state.models.some((model) => model.id === id)) throw new Error('Choose a listed free model')
    this.state.config.modelId = id; this.persist(); this.emit()
    return this.snapshot()
  }
  private requireConnected() { if (this.state.connection !== 'connected') throw new Error('Connect to OpenCode first') }
  async send(input: unknown) {
    this.requireConnected()
    if (typeof input !== 'string' || !input.trim() || input.length > 12_000) throw new Error('Enter a message under 12,000 characters')
    if (this.state.busy) throw new Error('Wait for Nova or press Stop')
    const id = this.state.config.sessionId
    if (!id) throw new Error('Start or select a session')
    await this.refreshToolIds()
    await this.refreshModels(false)
    const session = await this.request(this.path(`/session/${encodeURIComponent(id)}`))
    if (!parseSession(session, this.state.config.workspace, this.toolIds)?.safe) throw new Error('This session does not enforce chat-only tool denial')
    const model = this.state.models.find((candidate) => candidate.id === this.state.config.modelId)
    if (!model) throw new Error('Select a listed free model')
    const tools = Object.fromEntries(this.toolIds.map((tool) => [tool, false]))
    this.pendingUntil = Date.now() + 3000
    this.state.busy = true; this.state.deliveryUncertain = false; this.emit()
    try {
      const personality = getNovaPersonality(this.state.config.workspace)
      const system = buildDiscussionSystem(personality)
      await this.request(this.path(`/session/${encodeURIComponent(id)}/prompt_async`), { method: 'POST', body: JSON.stringify({ model: { providerID: model.providerID, modelID: model.modelID }, agent: 'plan', system, tools, parts: [{ type: 'text', text: input.trim() }] }) }, 30000)
      await this.refreshActivity(); this.emit()
    } catch (error) {
      this.state.deliveryUncertain = true
      this.state.error = `Delivery unconfirmed: ${cleanError(error)}. Check session history before retrying.`
      this.emit()
      throw error
    }
    return this.snapshot()
  }
  async stop() {
    this.requireConnected()
    const id = this.state.config.sessionId
    if (!id || !sessionPattern.test(id)) throw new Error('No active session')
    await this.request(this.path(`/session/${encodeURIComponent(id)}/abort`), { method: 'POST' })
    this.pendingUntil = 0
    this.toolIds = []
    await this.refreshActivity(); this.emit()
    return this.snapshot()
  }
  async startServer() {
    const executable = validExecutable(this.state.config.executablePath)
    const version = this.detectVersion(executable)
    if (!version) throw new Error('OpenCode executable could not be started')
    const workspace = validWorkspace(this.state.config.workspace)
    const endpoint = new URL(this.state.config.endpoint)
    if (this.owned) throw new Error('A server started by NovaCourt is already running')
    try {
      const health = await this.request('/global/health', undefined, 1000)
      if (health?.healthy) throw new Error('An OpenCode server is already running here. Use Connect.')
    } catch (error) {
      if (error instanceof Error && error.message.includes('already running')) throw error
    }
    this.owned = spawn(executable, ['serve', '--hostname', endpoint.hostname === '[::1]' ? '::1' : '127.0.0.1', '--port', endpoint.port, '--pure'], { cwd: workspace, windowsHide: true, stdio: 'ignore', env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' } }) } })
    this.owned.once('exit', () => { this.owned = null; if (!this.closed) { this.state.connection = 'disconnected'; this.state.error = 'Local OpenCode server stopped'; this.emit() } })
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((done) => setTimeout(done, 500))
      try { const health = await this.request('/global/health', undefined, 1000); if (health?.healthy) return this.connect() } catch { /* Wait for startup. */ }
    }
    throw new Error('OpenCode server did not become available on the configured endpoint')
  }
  private beginPolling() {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => { void this.poll().catch((error) => { this.state.connection = 'error'; this.state.error = cleanError(error); this.emit() }) }, 5000)
    this.activityTimer = setInterval(() => { if (this.state.connection === 'connected' && this.state.config.sessionId && this.state.busy) void this.refreshActivity().then(() => this.emit()).catch(() => {}) }, 1200)
  }
  private async poll() {
    if (this.closed) return
    try {
      const health = await this.request('/global/health', undefined, 2500)
      if (health?.healthy !== true) throw new Error('OpenCode health check failed')
      if (this.state.connection !== 'connected') await this.connect()
    } catch (error) {
      this.state.connection = 'disconnected'; this.state.error = `Connection lost: ${cleanError(error)}`; this.emit()
      this.eventAbort?.abort(); this.eventAbort = null
    }
  }
  private beginEvents() {
    this.eventAbort?.abort()
    const controller = new AbortController()
    this.eventAbort = controller
    void (async () => {
      try {
        const response = await fetch(new URL(this.path('/event'), `${this.state.config.endpoint}/`), { signal: controller.signal, headers: { accept: 'text/event-stream' } })
        if (!response.ok || !response.body) throw new Error('OpenCode event stream unavailable')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split(/\r?\n\r?\n/)
          buffer = chunks.pop() || ''
          for (const chunk of chunks) {
            const line = chunk.split(/\r?\n/).filter((item) => item.startsWith('data:')).map((item) => item.slice(5).trim()).join('')
            if (!line) continue
            try {
              const event = JSON.parse(line)
              const sessionId = event.properties?.sessionID || event.properties?.part?.sessionID || event.properties?.info?.sessionID
              if (sessionId === this.state.config.sessionId && /^(message\.|session\.|permission\.)/.test(event.type)) void this.refreshActivity().then(() => this.emit()).catch(() => {})
            } catch { /* Ignore malformed event, polling remains active. */ }
          }
        }
      } catch { /* Health polling will reconnect. */ }
      if (!this.closed && !controller.signal.aborted && this.state.connection === 'connected') setTimeout(() => { if (this.state.connection === 'connected') this.beginEvents() }, 1500)
    })()
  }
  disconnect() {
    this.eventAbort?.abort(); this.eventAbort = null
    if (this.healthTimer) clearInterval(this.healthTimer)
    if (this.activityTimer) clearInterval(this.activityTimer)
    this.healthTimer = null; this.activityTimer = null
    this.pendingUntil = 0
    this.state.connection = 'disconnected'; this.state.version = null; this.state.busy = false; this.state.sessions = []; this.state.messages = []; this.state.models = []
    this.emit()
  }
  close() {
    this.closed = true; this.disconnect()
    if (this.owned && !this.owned.killed) this.owned.kill()
    this.owned = null
  }
}
