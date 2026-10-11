import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Gavel, MessageCircle, RotateCcw, Settings2, Sparkles } from 'lucide-react'
import type { AstraStatus, PanelWidths, ViewRequest } from './types'
import NovaPanel from './NovaPanel'

type Page = 'conversation' | 'settings'
type Note = { id: string; text: string; createdAt: string }
const defaults: PanelWidths = { karl: 34, astra: 35, nova: 31 }
const notesKey = 'novacourt-v2:karl-notes'

function readNotes(): Note[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(notesKey) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is Note => item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.createdAt === 'string').slice(-100) : []
  } catch { return [] }
}

export default function App() {
  const [page, setPage] = useState<Page>('conversation')
  const [widths, setWidths] = useState<PanelWidths>(defaults)
  const [notes, setNotes] = useState<Note[]>(readNotes)
  const [draft, setDraft] = useState('')
  const [astraStatus, setAstraStatus] = useState<AstraStatus>({ source: 'chatgpt', phase: 'loading', detail: 'Loading ChatGPT website' })
  const gridRef = useRef<HTMLDivElement>(null)
  const astraViewportRef = useRef<HTMLDivElement>(null)
  const notesEndRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ side: 'left' | 'right'; startX: number; initial: PanelWidths; width: number } | null>(null)

  useEffect(() => { void window.novaCourt.readSettings().then((settings) => setWidths(settings.panelWidths)) }, [])
  useEffect(() => {
    const remove = window.novaCourt.onAstraStatus(setAstraStatus)
    void window.novaCourt.readAstraStatus().then(setAstraStatus)
    return remove
  }, [])
  useEffect(() => { localStorage.setItem(notesKey, JSON.stringify(notes)) }, [notes])

  const syncAstra = useCallback(() => {
    const element = astraViewportRef.current
    const visible = page === 'conversation' && !!element && element.getClientRects().length > 0
    const bounds = visible ? element!.getBoundingClientRect() : null
    const request: ViewRequest = {
      visible,
      rect: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { x: 0, y: 0, width: 0, height: 0 },
      zoom: window.visualViewport?.scale ?? 1
    }
    window.novaCourt.setAstraBounds(request)
  }, [page])

  useLayoutEffect(() => {
    const element = astraViewportRef.current
    const observer = new ResizeObserver(syncAstra)
    if (element) observer.observe(element)
    if (gridRef.current) observer.observe(gridRef.current)
    const frame = requestAnimationFrame(syncAstra)
    const removeWindowListener = window.novaCourt.onWindowResize(syncAstra)
    window.addEventListener('resize', syncAstra)
    return () => { cancelAnimationFrame(frame); observer.disconnect(); removeWindowListener(); window.removeEventListener('resize', syncAstra); window.novaCourt.setAstraBounds({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, zoom: 1 }) }
  }, [syncAstra])

  function startResize(side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) {
    if (!gridRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { side, startX: event.clientX, initial: widths, width: gridRef.current.clientWidth - 16 }
  }
  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    const drag = resizeRef.current
    if (!drag) return
    const delta = ((event.clientX - drag.startX) / drag.width) * 100
    const minPercent = Math.max(20, (260 / drag.width) * 100)
    let next: PanelWidths
    if (drag.side === 'left') {
      const karl = Math.min(drag.initial.karl + drag.initial.astra - minPercent, Math.max(minPercent, drag.initial.karl + delta))
      next = { karl, astra: drag.initial.karl + drag.initial.astra - karl, nova: drag.initial.nova }
    } else {
      const astra = Math.min(drag.initial.astra + drag.initial.nova - minPercent, Math.max(minPercent, drag.initial.astra + delta))
      next = { karl: drag.initial.karl, astra, nova: drag.initial.astra + drag.initial.nova - astra }
    }
    setWidths(next)
    requestAnimationFrame(syncAstra)
  }
  function stopResize() {
    if (!resizeRef.current) return
    resizeRef.current = null
    void window.novaCourt.saveWidths(widths)
  }
  function addNote(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setNotes((previous) => [...previous, { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }].slice(-100))
    setDraft('')
    requestAnimationFrame(() => notesEndRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }
  function resetWidths() { setWidths(defaults); void window.novaCourt.saveWidths(defaults) }
  const astraLabel: Record<AstraStatus['phase'], string> = { loading: 'LOADING', open: astraStatus.source === 'fixture' ? 'OFFLINE FIXTURE' : 'WEBSITE OPEN', 'sign-in-page': 'SIGN-IN PAGE', offline: 'OFFLINE', error: 'LOAD ERROR', blocked: 'LINK BLOCKED' }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="brand-mark"><Gavel size={21} strokeWidth={2.2}/></div><div><div className="brand-name">NOVA<span>COURT</span></div><div className="brand-sub">BRIGHTSENAPPS · V2</div></div></div>
      <nav className="top-nav" aria-label="Main navigation">
        <button className={page === 'conversation' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('conversation')}><MessageCircle size={16}/> Conversation</button>
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('settings')}><Settings2 size={16}/> Settings</button>
      </nav>
      <div className="header-right"><span className="session-tag"><span className="session-dot"/> LOCAL SESSION</span><button className="hammer-button" title="Courtroom actions are planned for a later milestone" aria-label="Astra hammer, future actions" disabled><Gavel size={18}/></button></div>
    </header>

    {page === 'conversation' ? <main className="conversation-screen">
      <div className="screen-heading"><div><span className="eyebrow">THE CONVERSATION</span><h1>Three seats. One conversation.</h1></div><div className="stage-label"><span className="stage-line"/> M3 · NOVA DISCUSSION</div></div>
      <div className="court-grid" ref={gridRef} style={{ gridTemplateColumns: `${widths.karl}fr 8px ${widths.astra}fr 8px ${widths.nova}fr` }}>
        <section className="participant-panel karl-panel" aria-label="Karl panel">
          <div className="panel-head"><div className="identity"><div className="avatar karl-avatar">K</div><div><div className="seat">LEFT SEAT · THE OWNER</div><h2>Karl</h2></div></div><span className="status ready"><span/> READY</span></div>
          <div className="panel-body karl-body"><div className="thread-label">LOCAL NOTES <span>{notes.length ? `${notes.length} saved` : 'Private to this app'}</span></div>
            {notes.length === 0 ? <div className="empty-state"><div className="empty-icon"><MessageCircle size={24}/></div><h3>Your conversation starts here.</h3><p>Capture your thoughts in Karl’s seat. Notes stay local; use Nova’s composer to send a discussion message.</p></div> : <div className="note-list">{notes.map((note) => <article className="note" key={note.id}><div className="note-meta"><span className="mini-avatar">K</span> KARL · LOCAL NOTE <time>{new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{note.text}</p></article>)}<div ref={notesEndRef}/></div>}
          </div>
          <form className="composer" onSubmit={addNote}><div className="composer-to">SAVE TO <strong>KARL’S LOCAL NOTES</strong><ChevronDown size={13}/></div><div className="composer-input"><textarea aria-label="Write a local note" placeholder="Write a thought for the court..." value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} rows={3}/><button type="submit" aria-label="Save local note" disabled={!draft.trim()}><ArrowUp size={18}/></button></div><div className="composer-hint">Enter to save <span>·</span> Shift + Enter for a new line</div></form>
        </section>
        <div className="divider" role="separator" aria-label="Resize Karl and Astra panels" aria-orientation="vertical" onPointerDown={(event) => startResize('left', event)} onPointerMove={moveResize} onPointerUp={stopResize} onLostPointerCapture={stopResize}><span/></div>
        <section className="participant-panel astra-panel" aria-label="Astra panel"><div className="panel-head"><div className="identity"><div className="avatar astra-avatar"><Sparkles size={19}/></div><div><div className="seat">MIDDLE SEAT · CHATGPT</div><h2>Astra</h2></div></div><div className="astra-controls"><span className={`status astra-${astraStatus.phase}`} title={astraStatus.detail}><span/> {astraLabel[astraStatus.phase]}</span><button className="astra-retry" type="button" onClick={() => window.novaCourt.retryAstra()} title="Reload ChatGPT website" aria-label="Reload Astra website"><RotateCcw size={14}/></button></div></div><div className="native-viewport" ref={astraViewportRef} data-testid="astra-viewport"/></section>
        <div className="divider" role="separator" aria-label="Resize Astra and Nova panels" aria-orientation="vertical" onPointerDown={(event) => startResize('right', event)} onPointerMove={moveResize} onPointerUp={stopResize} onLostPointerCapture={stopResize}><span/></div>
        <NovaPanel/>
      </div>
      <div className="screen-foot"><span><span className="foot-dot"/> A local workspace for Karl</span><span>{astraStatus.source === 'fixture' ? 'Offline fixture for layout tests' : 'ChatGPT is manual · account status is not detected'} · Nova messages send only from Nova’s composer</span></div>
    </main> : <main className="settings-screen"><div className="settings-wrap"><span className="eyebrow">PREFERENCES</span><h1>Make room for every voice.</h1><p className="settings-intro">Panel widths are saved on this device. ChatGPT opens in a dedicated persistent Electron session; sign in manually in Astra’s panel. The app does not read your account or conversations.</p><div className="setting-card"><div><h2>Conversation layout</h2><p>Drag either divider on the Conversation screen to change panel widths.</p><div className="width-values"><span>Karl {Math.round(widths.karl)}%</span><span>Astra {Math.round(widths.astra)}%</span><span>Nova {Math.round(widths.nova)}%</span></div></div><button onClick={resetWidths}><RotateCcw size={15}/> Reset widths</button></div><button className="back-button" onClick={() => setPage('conversation')}>← Back to Conversation</button></div></main>}
  </div>
}
