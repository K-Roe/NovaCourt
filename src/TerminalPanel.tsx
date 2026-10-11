import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalMode, TerminalState } from './types'

const initial: TerminalState = { id: null, mode: null, status: 'idle', workspace: null, pid: null, cols: null, rows: null, exitCode: null, error: null, buffer: '' }

export default function TerminalPanel({ mode, workspace }: { mode: TerminalMode; workspace: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const stateRef = useRef<TerminalState>(initial)
  const [state, setState] = useState<TerminalState>(initial)
  const [error, setError] = useState<string | null>(null)
  // The trust notice is the tallest fixed block above the screen. Collapsing it gives a short window
  // back the rows it needs to run a real terminal; the warning itself stays one click away.
  const [trustOpen, setTrustOpen] = useState(true)
  const title = mode === 'opencode' ? 'OpenCode Terminal' : 'PowerShell Terminal'
  const activeHere = state.mode === mode && state.status === 'running'
  const anotherActive = state.mode !== mode && (state.status === 'running' || state.status === 'stopping')

  useEffect(() => {
    if (!hostRef.current) return
    const terminal = new Terminal({ cursorBlink: true, scrollback: 5000, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, lineHeight: 1.25, theme: { background: '#11131b', foreground: '#e9e7e5', cursor: '#e5a26b', selectionBackground: '#584437' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostRef.current)
    terminalRef.current = terminal
    fitRef.current = fit
    const resize = () => {
      if (!hostRef.current?.clientWidth || !hostRef.current?.clientHeight) return
      fit.fit()
      const current = stateRef.current
      // Clamp rather than skip. A short panel must still resize the PTY's width, but ConPTY throws on
      // a degenerate height, so the floor is applied here and the PTY is never asked for fewer than
      // five rows. Recording the clamped values keeps the PTY and the UI agreeing on one size.
      const cols = Math.max(20, terminal.cols)
      const rows = Math.max(5, terminal.rows)
      if (current.id && current.status === 'running' && current.mode === mode) window.novaCourt.resizeTerminal(current.id, { cols, rows })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(hostRef.current)
    const input = terminal.onData((data) => {
      const current = stateRef.current
      if (current.id && current.mode === mode && current.status === 'running') window.novaCourt.writeTerminal(current.id, data)
    })
    const unsubscribeState = window.novaCourt.onTerminalState((next) => {
      const previous = stateRef.current
      stateRef.current = next
      setState(next)
      if (next.id !== previous.id || (next.mode === mode && next.buffer.length < previous.buffer.length)) {
        terminal.reset()
        if (next.mode === mode && next.buffer) terminal.write(next.buffer)
      }
    })
    const unsubscribeData = window.novaCourt.onTerminalData(({ id, data }) => {
      if (stateRef.current.id === id && stateRef.current.mode === mode) terminal.write(data)
    })
    void window.novaCourt.getTerminalState().then((next) => {
      stateRef.current = next
      setState(next)
      if (next.mode === mode && next.buffer) terminal.write(next.buffer)
      resize()
    }).catch((cause) => setError(String(cause)))
    queueMicrotask(resize)
    return () => { observer.disconnect(); input.dispose(); unsubscribeState(); unsubscribeData(); terminal.dispose(); terminalRef.current = null; fitRef.current = null }
  }, [mode])

  function size() {
    fitRef.current?.fit()
    return { cols: Math.max(20, terminalRef.current?.cols || 80), rows: Math.max(5, terminalRef.current?.rows || 24) }
  }
  async function run(operation: () => Promise<TerminalState>) {
    setError(null)
    try { const next = await operation(); stateRef.current = next; setState(next); if (next.status === 'running') terminalRef.current?.focus() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <div className="court-terminal-view">
    <div className="court-terminal-bar"><strong>{title}</strong><span className={`court-terminal-status ${state.status}`}>{state.mode === mode ? state.status.toUpperCase() : anotherActive ? 'OTHER TERMINAL ACTIVE' : 'NOT STARTED'}</span></div>
    {trustOpen
      ? <div className="court-terminal-trust">DIRECT TERMINAL · HIGHER TRUST<br/>Commands and OpenCode tools run with Karl’s local account permissions. Nova Chat’s tool restrictions do not apply here. Choose your OpenCode model; provider charges may apply.<button className="court-terminal-trust-toggle" onClick={() => setTrustOpen(false)}>Hide</button></div>
      : <button className="court-terminal-trust-collapsed" onClick={() => setTrustOpen(true)}>DIRECT TERMINAL · HIGHER TRUST · Nova Chat’s tool restrictions do not apply here</button>}
    <div className="court-terminal-workspace" title={workspace}>Workspace: {state.mode === mode && state.workspace ? state.workspace : workspace}</div>
    <div className="court-terminal-controls">
      <button onClick={() => run(() => window.novaCourt.startTerminal(mode, size()))} disabled={activeHere || anotherActive || state.status === 'stopping'}>Start</button>
      <button onClick={() => run(() => window.novaCourt.stopTerminal())} disabled={!activeHere}>Stop</button>
      <button onClick={() => run(() => window.novaCourt.restartTerminal(mode, size()))} disabled={anotherActive || state.status === 'stopping'}>Restart</button>
      <button onClick={() => { terminalRef.current?.clear(); void run(() => window.novaCourt.clearTerminal()) }} disabled={state.mode !== mode}>Clear</button>
    </div>
    <div className="court-terminal-screen" ref={hostRef} aria-label={`${title} output`}/>
    <div className="court-terminal-foot">{state.mode === mode && state.pid ? `PID ${state.pid}` : state.mode === mode && state.status === 'exited' ? `Exited with code ${state.exitCode ?? 'unknown'}` : 'Click Start to launch an interactive session.'}</div>
    {(error || (state.mode === mode && state.error)) && <div className="court-terminal-error" role="alert">{error || state.error}</div>}
  </div>
}
