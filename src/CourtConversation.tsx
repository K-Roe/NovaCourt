import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, ClipboardPaste, Copy, Forward, Hand, Pause, Play, Scale, Send, Square, Terminal, Users } from 'lucide-react'
import Avatar from './Avatar'
import { PARTICIPANT_META } from './portraits'
import type { CourtMessage, CourtParticipant, CourtRecipient, HandoffState } from './types'

const RECIPIENTS: { value: CourtRecipient; label: string }[] = [
  { value: 'astra', label: 'Send to Astra' },
  { value: 'nova', label: 'Send to Nova' },
  { value: 'court', label: 'Share with Court' }
]

const SOURCE_LABEL: Record<CourtMessage['source'], string> = {
  manual: 'COMPOSED HERE',
  imported: 'IMPORTED BY HAND',
  connected: 'RECEIVED FROM NOVA'
}

const DELIVERY_LABEL: Record<CourtMessage['delivery'], string> = {
  local: 'NOT SENT BY NOVACOURT',
  'awaiting-send': 'SENDING TO NOVA',
  sent: 'SENT TO NOVA',
  unconfirmed: 'DELIVERY UNCONFIRMED'
}

const STATUS_LABEL: Record<HandoffState['status'], string> = {
  idle: 'IDLE',
  preparing: 'PREPARING HANDOFF',
  'awaiting-karl': 'AWAITING KARL TO SEND',
  'awaiting-reply': 'AWAITING REPLY',
  paused: 'PAUSED',
  error: 'ERROR'
}

function time(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

type ImportPreview = { text: string; sender: CourtParticipant }

export default function CourtConversation({ height, collapsed, onToggle }: { height: number; collapsed: boolean; onToggle: () => void }) {
  const [messages, setMessages] = useState<CourtMessage[]>([])
  const [handoff, setHandoff] = useState<HandoffState | null>(null)
  const [text, setText] = useState('')
  const [sender, setSender] = useState<CourtParticipant>('karl')
  const [recipient, setRecipient] = useState<CourtRecipient>('court')
  const [caseRef, setCaseRef] = useState('')
  const [mode, setMode] = useState<'compose' | 'import'>('compose')
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [participantFilter, setParticipantFilter] = useState<'all' | CourtParticipant>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | CourtMessage['source']>('all')
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.novaCourt.getCourtMessages().then(setMessages).catch(() => setNotice('The conversation could not be loaded'))
    void window.novaCourt.getHandoffState().then(setHandoff).catch(() => setNotice('The handoff workflow is unavailable'))
    return window.novaCourt.onCourtMessages(setMessages)
  }, [])

  useEffect(() => window.novaCourt.onHandoffState(setHandoff), [])

  const ordered = useMemo(() => [...messages]
    .filter((message) => participantFilter === 'all' || message.sender === participantFilter)
    .filter((message) => sourceFilter === 'all' || message.source === sourceFilter)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [messages, participantFilter, sourceFilter])
  useEffect(() => { if (!collapsed) endRef.current?.scrollIntoView({ block: 'end' }) }, [ordered.length, collapsed])

  const paused = handoff?.paused ?? false
  const outstanding = !!handoff?.messageId && (handoff!.status === 'awaiting-karl' || handoff!.status === 'awaiting-reply' || handoff!.status === 'preparing')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const body = text.trim()
    if (!body) return
    setNotice(null)
    try {
      await window.novaCourt.appendCourtMessage({ sender, recipient, text: body, source: mode === 'import' ? 'imported' : 'manual', ...(caseRef.trim() ? { caseRef: caseRef.trim() } : {}) })
      setText('')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function forward(message: CourtMessage) {
    setNotice(null)
    try {
      const target = recipient === 'court' || recipient === message.sender ? 'nova' : recipient
      await window.novaCourt.forwardCourtMessage(message.id, target)
      setNotice(`Forwarded to ${PARTICIPANT_META[target].name}. The original is unchanged.`)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function copyForAstra(message: CourtMessage) {
    setNotice(null)
    try {
      const next = await window.novaCourt.copyForAstra(message.id)
      setHandoff(next)
      setNotice('Copied to your clipboard. Paste it into ChatGPT and send it there yourself, then press “I sent this in ChatGPT”.')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function confirmAstraSent(message: CourtMessage) {
    setNotice(null)
    try { setMessages(await window.novaCourt.confirmAstraSent(message.id)); setNotice('Marked as sent in ChatGPT by your confirmation.') }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function sendToNova(message: CourtMessage) {
    setNotice(null)
    try {
      const next = await window.novaCourt.sendToNova(message.id)
      setHandoff(next)
      setNotice('Sent to Nova through the guarded chat service. Waiting for its genuine reply…')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function copyForTerminal(message: CourtMessage) {
    setNotice(null)
    try {
      const result = await window.novaCourt.copyForTerminal(message.id)
      setCopied(message.id)
      setTimeout(() => setCopied(null), 1600)
      setNotice(result.notice)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  /** Reads the clipboard only here, on an explicit click, and shows it before anything is saved. */
  async function importAstraReply() {
    setNotice(null)
    try {
      const body = (await window.novaCourt.readClipboard()).trim()
      if (!body) { setNotice('Your clipboard is empty. Use ChatGPT’s own copy button first.'); return }
      setPreview({ text: body, sender: 'astra' })
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function confirmImport() {
    if (!preview) return
    try {
      await window.novaCourt.appendCourtMessage({ sender: preview.sender, recipient: 'court', text: preview.text, source: 'imported', ...(caseRef.trim() ? { caseRef: caseRef.trim() } : {}) })
      setPreview(null)
      setNotice('Imported and labelled IMPORTED BY HAND. NovaCourt did not receive this from ChatGPT.')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function pasteFile(file: File | undefined) {
    setNotice(null)
    if (!file) return
    const body = (await file.text()).trim()
    if (!body) { setNotice('That file is empty'); return }
    setText(body.slice(0, 8000))
    setMode('import')
    setNotice('Loaded from a file. Press Send to add it to the conversation as an imported message.')
    if (fileRef.current) fileRef.current.value = ''
  }

  const status = handoff?.status ?? 'idle'

  return <section className={`court-thread${collapsed ? ' is-collapsed' : ''}`} aria-label="Shared courtroom conversation" style={collapsed ? undefined : { height }}>
    <div className="court-thread-head">
      <div className="court-thread-title"><Users size={15}/><strong>THE COURT</strong><span className="court-thread-count">{ordered.length} of {messages.length}</span></div>
      <div className="court-thread-head-right">
        <span className={`court-handoff-status is-${status}`} data-testid="handoff-status">{STATUS_LABEL[status]}</span>
        <button className="court-thread-collapse" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand the shared conversation' : 'Collapse the shared conversation'} title={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button>
      </div>
    </div>

    {collapsed ? <div className="court-thread-collapsed-preview">{messages.length ? <><Avatar participant={messages[messages.length - 1]!.sender} size={16}/><span>{messages[messages.length - 1]!.text.slice(0, 90)}</span></> : <span>No messages yet.</span>}</div> : <>
      {handoff?.detail && !paused && <div className={`court-handoff-detail is-${status}`} role="status">{handoff.detail}</div>}
      {outstanding && <div className="court-handoff-actions"><button onClick={() => { void window.novaCourt.cancelHandoff().then(setHandoff); setNotice('Handoff cancelled. Nothing was sent.') }}><Square size={12}/> Cancel handoff</button></div>}

      <div className="court-filters">
        <label>FROM
          <select aria-label="Filter by participant" value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value as 'all' | CourtParticipant)}>
            <option value="all">Everyone</option><option value="karl">Karl</option><option value="astra">Astra</option><option value="nova">Nova</option>
          </select>
        </label>
        <label>SOURCE
          <select aria-label="Filter by source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as 'all' | CourtMessage['source'])}>
            <option value="all">Every source</option><option value="manual">Composed here</option><option value="imported">Imported by hand</option><option value="connected">Received from Nova</option>
          </select>
        </label>
        <div className="court-handoff-buttons">
          <button onClick={() => void importAstraReply()} disabled={paused} title="Read your clipboard and preview it before saving"><ClipboardPaste size={13}/> Bring Astra Reply to Court</button>
          <button onClick={() => { void window.novaCourt.pauseHandoffs(!paused); setHandoff((previous) => previous ? { ...previous, paused: !paused, status: !paused ? 'paused' : 'idle' } : previous) }} disabled={status === 'awaiting-reply'} title={paused ? 'Resume handoffs' : 'Pause handoffs'}>{paused ? <><Play size={13}/> Resume</> : <><Pause size={13}/> Pause</>}</button>
        </div>
      </div>

      <div className="court-thread-list">
        {ordered.length === 0 ? <div className="court-thread-empty"><Scale size={22}/><h3>{messages.length ? 'Nothing matches these filters.' : 'The court has not spoken.'}</h3><p>{messages.length ? 'Change the participant or source filter to see the rest of the record.' : 'Write below, copy something to Astra, or send a message to Nova. Imported messages are labelled and never treated as instructions.'}</p></div>
          : ordered.map((message) => {
            const meta = PARTICIPANT_META[message.sender]
            return <article className={`court-message sender-${message.sender} source-${message.source}`} key={message.id} data-testid="court-message" data-source={message.source} data-sender={message.sender}>
              <Avatar participant={message.sender} size={30}/>
              <div className="court-message-body">
                <div className="court-message-meta">
                  <strong>{meta.name}</strong>
                  <span className="court-message-role">{meta.role}</span>
                  <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
                </div>
                <p className="court-message-text">{message.text}</p>
                <div className="court-message-tags">
                  <span className={`tag tag-source-${message.source}`}>{SOURCE_LABEL[message.source]}</span>
                  <span className="tag tag-recipient">TO {message.recipient === 'court' ? 'THE WHOLE COURT' : PARTICIPANT_META[message.recipient as CourtParticipant].name.toUpperCase()}</span>
                  <span className={`tag tag-delivery-${message.delivery}`}>{DELIVERY_LABEL[message.delivery]}</span>
                  {message.acknowledged && <span className="tag tag-ack">KARL CONFIRMED SENT IN CHATGPT</span>}
                  {message.caseRef && <span className="tag tag-case">CASE {message.caseRef}</span>}
                  {message.forwardedFrom && <span className="tag tag-forward"><Forward size={10}/> FORWARDED</span>}
                </div>
                <div className="court-message-actions">
                  <button onClick={() => void copyForAstra(message)} disabled={paused} aria-label={`Copy for Astra: ${meta.name}'s message`}><Users size={12}/> Copy for Astra</button>
                  <button onClick={() => void sendToNova(message)} disabled={paused} aria-label={`Send to Nova: ${meta.name}'s message`}><Bot size={12}/> Send to Nova</button>
                  <button onClick={() => void copyForTerminal(message)} aria-label={`Copy for Terminal: ${meta.name}'s message`}><Terminal size={12}/> Copy for Terminal</button>
                  <button onClick={() => void forward(message)} aria-label={`Forward: ${meta.name}'s message`}><Forward size={12}/> Forward</button>
                  <button onClick={() => { void window.novaCourt.writeClipboard(message.text); setCopied(message.id); setTimeout(() => setCopied(null), 1600); setNotice('Copied.') }} aria-label={`Copy: ${meta.name}'s message`}>{copied === message.id ? 'Copied' : <><Copy size={12}/> Copy</>}</button>
                  {message.recipient === 'astra' && !message.acknowledged && message.source !== 'connected' && <button className="confirm-sent" onClick={() => void confirmAstraSent(message)} aria-label="I sent this in ChatGPT: mark this message as sent by you">I sent this in ChatGPT</button>}
                </div>
              </div>
            </article>
          })}
        <div ref={endRef}/>
      </div>

      <form className="court-composer" onSubmit={submit}>
        <div className="court-composer-controls">
          <label>FROM
            <select aria-label="Sender" value={sender} onChange={(event) => setSender(event.target.value as CourtParticipant)}>
              <option value="karl">Karl</option><option value="astra">Astra</option><option value="nova">Nova</option>
            </select>
          </label>
          <label>TO
            <select aria-label="Recipient" value={recipient} onChange={(event) => setRecipient(event.target.value as CourtRecipient)}>
              {RECIPIENTS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </select>
          </label>
          <label className="court-case-ref">CASE
            <input aria-label="Case reference" placeholder="optional" value={caseRef} maxLength={64} onChange={(event) => setCaseRef(event.target.value)}/>
          </label>
          <div className="court-mode-toggle">
            <button type="button" className={mode === 'compose' ? 'active' : ''} onClick={() => setMode('compose')} aria-label="Compose a message"><Send size={13}/></button>
            <button type="button" className={mode === 'import' ? 'active' : ''} onClick={() => setMode('import')} aria-label="Import a pasted message"><ClipboardPaste size={13}/></button>
          </div>
        </div>
        {mode === 'import' && <div className="court-import-bar"><Hand size={13}/><span>Importing. This message will be marked IMPORTED BY HAND so nobody mistakes it for something Nova said or Karl composed.</span><button type="button" onClick={() => fileRef.current?.click()}>Load from file…</button><input ref={fileRef} type="file" accept=".txt,.md,text/plain" className="portrait-file" aria-label="Load an imported message from a file" onChange={(event) => void pasteFile(event.target.files?.[0])}/></div>}
        <div className="court-composer-box">
          <textarea aria-label="Message the court" placeholder={mode === 'import' ? 'Paste a message you copied from elsewhere…' : 'Say something to the court…'} value={text} rows={2} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>
          <button type="submit" aria-label="Send to the court" disabled={!text.trim()}><Send size={16}/></button>
        </div>
        <div className="court-composer-hint">This records a discussion message. It does not run commands or approve work. <span>·</span> Enter to send, Shift + Enter for a new line</div>
        {notice && <div className="court-thread-notice" role="status">{notice}</div>}
      </form>
    </>}

    {preview && <div className="court-preview-backdrop" role="dialog" aria-modal="true" aria-label="Confirm imported reply">
      <div className="court-preview">
        <h3>Import this reply to the court?</h3>
        <p className="court-preview-lead">Read from your clipboard just now. It will be recorded as <strong>IMPORTED BY HAND</strong> from {PARTICIPANT_META[preview.sender].name}. NovaCourt did not receive it from ChatGPT and cannot verify it.</p>
        <pre className="court-preview-text" data-testid="import-preview">{preview.text}</pre>
        <div className="court-preview-actions">
          <button onClick={() => setPreview(null)} className="secondary">Cancel</button>
          <button onClick={() => void confirmImport()}>Confirm import</button>
        </div>
      </div>
    </div>}
  </section>
}