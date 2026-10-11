import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUp, CircleStop, Plus, RotateCcw, Settings2, ShieldCheck, WifiOff } from 'lucide-react'
import Avatar from './Avatar'
import type { NovaState } from './types'

const TerminalPanel = lazy(() => import('./TerminalPanel'))

const initial: NovaState = { connection: 'disconnected', error: null, version: null, installedVersion: null, executableFound: false, config: { endpoint: 'http://127.0.0.1:4096', executablePath: '', workspace: '', sessionId: null, modelId: null }, sessions: [], messages: [], models: [], busy: false, deliveryUncertain: false }
const labels = { disconnected: 'DISCONNECTED', connecting: 'CONNECTING', connected: 'CONNECTED', error: 'ERROR' }

export default function NovaPanel() {
  const [state, setState] = useState<NovaState>(initial)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<'opencode' | 'powershell' | 'chat'>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [form, setForm] = useState({ endpoint: initial.config.endpoint, executablePath: '', workspace: '' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = window.novaCourt.onNovaState(setState)
    void window.novaCourt.getNovaState().then((next) => { if (next) setState(next) }).catch((error) => setActionError(String(error)))
    return unsubscribe
  }, [])
  useEffect(() => { setForm({ endpoint: state.config.endpoint, executablePath: state.config.executablePath, workspace: state.config.workspace }) }, [state.config.endpoint, state.config.executablePath, state.config.workspace])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [state.messages.length, state.messages.at(-1)?.text])

  async function action(operation: () => Promise<NovaState>) {
    setWorking(true); setActionError(null)
    try { const next = await operation(); if (next) setState(next); return true } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); return false }
    finally { setWorking(false) }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (await action(() => window.novaCourt.sendNovaMessage(text))) setDraft('')
  }
  const currentSession = state.sessions.find((session) => session.id === state.config.sessionId)
  const canSend = state.connection === 'connected' && currentSession?.safe === true && !!state.config.modelId && !state.busy && !working
  const workspaceName = state.config.workspace.split(/[\\/]/).filter(Boolean).at(-1) || 'No workspace'

  return <section className="participant-panel nova-panel" aria-label="Nova panel">
    <div className="panel-head"><div className="identity"><Avatar participant="nova" size={34}/><div><div className="seat">RIGHT SEAT · OPENCODE</div><h2>Nova</h2></div></div><div className="nova-head-actions"><span className={`status nova-${state.connection}`}><span/> {view === 'chat' ? labels[state.connection] : `CHAT ${labels[state.connection]}`}</span><button className="nova-icon-button" aria-label="Nova settings" title="Connection and workspace settings" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={14}/></button></div></div>
    <div className="nova-workspace" title={state.config.workspace}><span>WORKSPACE</span><strong>{workspaceName}</strong><span className="nova-workspace-path">{state.config.workspace}</span></div>
    <div className="nova-view-tabs" role="tablist" aria-label="Nova views">
      <button role="tab" aria-selected={view === 'opencode'} onClick={() => setView('opencode')}>OpenCode Terminal</button>
      <button role="tab" aria-selected={view === 'powershell'} onClick={() => setView('powershell')}>PowerShell</button>
      <button role="tab" aria-selected={view === 'chat'} onClick={() => setView('chat')}>Nova Chat</button>
    </div>

    {settingsOpen ? <div className="nova-settings panel-body"><div className="nova-section-label">CONNECTION SETTINGS</div><label>Local endpoint<input aria-label="OpenCode endpoint" value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })}/></label><label>OpenCode executable<input aria-label="OpenCode executable" value={form.executablePath} onChange={(event) => setForm({ ...form, executablePath: event.target.value })}/></label><label>Repository workspace<input aria-label="Nova workspace" value={form.workspace} onChange={(event) => setForm({ ...form, workspace: event.target.value })}/></label><p>Choose an existing Git repository inside your repos directory. Changing workspace clears the chat session. Chat tools stay disabled; terminal commands use your local account.</p><div className="nova-settings-actions"><button disabled={working} onClick={() => action(() => window.novaCourt.configureNova(form))}>Save settings</button><button className="secondary" onClick={() => setSettingsOpen(false)}>Done</button></div><div className="nova-installed">Installed: {state.installedVersion ? `OpenCode ${state.installedVersion}` : 'Not detected at this path'}</div></div> : view === 'chat' ? <>
      {state.connection === 'connected' ? <>
        <div className="nova-session-row"><select aria-label="Nova session" value={state.config.sessionId || ''} onChange={(event) => { if (event.target.value) void action(() => window.novaCourt.selectNovaSession(event.target.value)) }}><option value="">Select a session</option>{state.sessions.map((session) => <option key={session.id} value={session.id}>{session.safe ? '' : 'Read only · '}{session.title}</option>)}</select><button className="nova-icon-button" aria-label="New Nova session" title="New chat-only session" disabled={working} onClick={() => action(() => window.novaCourt.createNovaSession())}><Plus size={16}/></button><button className="nova-icon-button" aria-label="Refresh Nova sessions" title="Refresh sessions" disabled={working} onClick={() => action(() => window.novaCourt.refreshNova())}><RotateCcw size={14}/></button></div>
        <div className="nova-mode-row"><span><ShieldCheck size={13}/> CHAT ONLY · TOOLS DISABLED</span><select aria-label="Free Nova model" value={state.config.modelId || ''} onChange={(event) => void action(() => window.novaCourt.chooseNovaModel(event.target.value))}><option value="">No free model</option>{state.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></div>
        <div className="panel-body nova-chat" aria-label="Nova message history">{!currentSession ? <div className="nova-empty"><div className="nova-symbol"><ShieldCheck size={25}/></div><h3>Choose a discussion.</h3><p>Start a chat-only session or select an existing one in this workspace.</p></div> : <><div className="nova-thread-label">{currentSession.safe ? 'DISCUSSION SESSION' : 'READ-ONLY SESSION'} <span>{state.messages.length} messages</span></div>{!currentSession.safe && <div className="nova-warning">This older session has no verified tool-deny policy. Its history is readable here; start a new chat-only session to send.</div>}{state.messages.map((message) => <article className={`nova-message ${message.role}`} key={message.id}><div className="nova-message-meta"><span><Avatar participant={message.role === 'user' ? 'karl' : 'nova'} size={15}/> {message.role === 'user' ? 'KARL' : 'NOVA'}</span><time>{message.created ? new Date(message.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time></div>{message.text && <p>{message.text}</p>}{message.tools.map((tool, index) => <div className="nova-tool" key={`${message.id}-${index}`}>TOOL · {tool.name} · {tool.status}</div>)}{message.error && <div className="nova-message-error">{message.error}</div>}</article>)}{state.busy && <div className="nova-thinking"><span className="nova-pulse"/> Nova is thinking or working…</div>}<div ref={endRef}/></>}</div>
        <form className="nova-composer" onSubmit={submit}><div className="nova-composer-top">TO NOVA <span>{currentSession?.safe ? 'DISCUSSION MODE' : 'SELECT A CHAT-ONLY SESSION'}</span></div><div className="nova-composer-box"><textarea aria-label="Message Nova" placeholder="Ask Nova a question..." value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} rows={2} disabled={!canSend}/>{state.busy ? <button type="button" className="stop" aria-label="Stop Nova response" onClick={() => action(() => window.novaCourt.stopNova())}><CircleStop size={19}/></button> : <button type="submit" aria-label="Send to Nova" disabled={!canSend || !draft.trim()}><ArrowUp size={18}/></button>}</div></form>
      </> : <div className="panel-body nova-disconnected"><div className="nova-symbol"><WifiOff size={25}/></div><h3>{state.connection === 'connecting' ? 'Connecting to OpenCode…' : 'Nova is not connected.'}</h3><p>{state.error || (state.executableFound ? 'Connect to a running local server, or start one here.' : 'OpenCode was not found at the configured executable path.')}</p><div className="nova-connect-actions"><button disabled={working || state.connection === 'connecting'} onClick={() => action(() => window.novaCourt.connectNova())}>Connect</button><button disabled={working || !state.executableFound} onClick={() => action(() => window.novaCourt.startNovaServer())}>Start local server</button></div><div className="nova-endpoint">{state.config.endpoint} · {state.installedVersion ? `v${state.installedVersion}` : 'not detected'}</div></div>}
    </> : <Suspense fallback={<div className="court-terminal-loading">Loading terminal…</div>}><TerminalPanel mode={view} workspace={state.config.workspace}/></Suspense>}
    {view === 'chat' && (actionError || state.deliveryUncertain) && <div className="nova-error" role="alert">{actionError || state.error || 'Delivery is unconfirmed. Check history before retrying.'}</div>}
  </section>
}
