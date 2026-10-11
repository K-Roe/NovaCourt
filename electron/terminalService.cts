import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { validExecutable, validWorkspace } from './openCodeService.cjs'

export type TerminalMode = 'opencode' | 'powershell'
export type TerminalState = {
  id: string | null
  mode: TerminalMode | null
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'error'
  workspace: string | null
  pid: number | null
  cols: number | null
  rows: number | null
  exitCode: number | null
  error: string | null
  buffer: string
}

const maxBuffer = 1_000_000

export class TerminalService {
  private process: pty.IPty | null = null
  private state: TerminalState = { id: null, mode: null, status: 'idle', workspace: null, pid: null, cols: null, rows: null, exitCode: null, error: null, buffer: '' }
  private exitWaiter: (() => void) | null = null

  constructor(
    private readonly publishState: (state: TerminalState) => void,
    private readonly publishData: (id: string, data: string) => void,
  ) {}

  snapshot(): TerminalState { return { ...this.state } }
  isRunning() { return this.process !== null }
  private emit() { this.publishState(this.snapshot()) }

  start(mode: unknown, workspaceInput: unknown, executableInput: unknown, size: unknown): TerminalState {
    if (this.process) throw new Error('Stop the active terminal before starting another')
    if (mode !== 'opencode' && mode !== 'powershell') throw new Error('Choose a terminal mode')
    const workspace = validWorkspace(workspaceInput)
    if (!size || typeof size !== 'object') throw new Error('Terminal size is missing')
    const { cols, rows } = size as { cols?: unknown; rows?: unknown }
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 20 || (cols as number) > 500 || (rows as number) < 5 || (rows as number) > 200) throw new Error('Invalid terminal size')
    const executable = mode === 'opencode'
      ? validExecutable(executableInput)
      : join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (!existsSync(executable)) throw new Error('PowerShell executable was not found')
    const id = randomUUID()
    const args = mode === 'opencode' ? ['--mini'] : ['-NoLogo']
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    delete env.NO_COLOR
    delete env.FORCE_COLOR
    try {
      const processHandle = pty.spawn(executable, args, {
        name: 'xterm-256color', cols: cols as number, rows: rows as number, cwd: workspace,
        env,
        useConpty: process.platform === 'win32',
      })
      this.process = processHandle
      this.state = { id, mode, status: 'running', workspace, pid: processHandle.pid, cols: cols as number, rows: rows as number, exitCode: null, error: null, buffer: '' }
      processHandle.onData((data) => {
        if (this.state.id !== id) return
        this.state.buffer = (this.state.buffer + data).slice(-maxBuffer)
        this.publishData(id, data)
      })
      processHandle.onExit(({ exitCode }) => {
        if (this.state.id !== id) return
        this.process = null
        this.state.status = 'exited'
        this.state.pid = null
        this.state.exitCode = exitCode
        this.emit()
        this.exitWaiter?.()
        this.exitWaiter = null
      })
      this.emit()
      return this.snapshot()
    } catch (error) {
      this.state = { id: null, mode, status: 'error', workspace, pid: null, cols: null, rows: null, exitCode: null, error: error instanceof Error ? error.message : String(error), buffer: '' }
      this.emit()
      return this.snapshot()
    }
  }

  write(id: unknown, data: unknown) {
    if (typeof id !== 'string' || id !== this.state.id || !this.process || this.state.status !== 'running') throw new Error('No matching active terminal')
    if (typeof data !== 'string' || !data || data.length > 8192) throw new Error('Invalid terminal input')
    this.process.write(data)
  }

  resize(id: unknown, size: unknown) {
    if (typeof id !== 'string' || id !== this.state.id || !this.process) return
    if (!size || typeof size !== 'object') throw new Error('Invalid terminal size')
    const { cols, rows } = size as { cols?: unknown; rows?: unknown }
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 20 || (cols as number) > 500 || (rows as number) < 5 || (rows as number) > 200) throw new Error('Invalid terminal size')
    // ConPTY throws on a degenerate window size. Recording the new geometry only after the call
    // succeeds means a rejected resize leaves the PTL state describing what is actually running,
    // instead of a size the process never adopted.
    try {
      this.process.resize(cols as number, rows as number)
    } catch (error) {
      this.state.error = `The terminal could not be resized: ${error instanceof Error ? error.message : String(error)}`
      this.emit()
      return
    }
    this.state.cols = cols as number
    this.state.rows = rows as number
  }

  async stop() {
    if (!this.process) return this.snapshot()
    this.state.status = 'stopping'
    this.emit()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.exitWaiter = null; reject(new Error('Terminal did not exit after Stop')) }, 5000)
      this.exitWaiter = () => { clearTimeout(timeout); resolve() }
      try { this.process?.kill() } catch (error) { clearTimeout(timeout); this.exitWaiter = null; reject(error) }
    })
    return this.snapshot()
  }

  clear() {
    this.state.buffer = ''
    this.emit()
    return this.snapshot()
  }

  close() {
    if (this.process) this.process.kill()
    this.process = null
    this.exitWaiter?.()
    this.exitWaiter = null
  }
}
