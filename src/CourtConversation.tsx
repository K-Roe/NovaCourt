import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ClipboardPaste, Copy, Forward, Hand, Scale, Send, Users } from 'lucide-react'
import Avatar from './Avatar'
import { PARTICIPANT_META } from './portraits'
import type { CourtMessage, CourtParticipant, CourtRecipient } from './types'

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
  local: 'LOCAL ONLY',
  'awaiting-send': 'AWAITING SEND',
  sent: 'DELIVERED',
  unconfirmed: 'DELIVERY UNCONFIRMED'
}

function time(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function CourtConversation({ height, collapsed, onToggle }: { height: number; collapsed: boolean; onToggle: () => void }) {
  const [messages, setMessages] = useState<CourtMessage[]>([])
  const [text, setText] = useState('')
  const [sender, setSender] = useState<CourtParticipant>('karl')
  const [recipient, setRecipient] = useState<CourtRecipient>('court')
  const [caseRef, setCaseRef] = useState('')
  const [mode, setMode] = useState<'compose' | 'import'>('compose')
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.novaCourt.getCourtMessages().then(setMessages).catch(() => setNotice('The conversation could not be loaded'))
    return window.novaCourt.onCourtMessages(setMessages)
  }, [])

  const ordered = useMemo(() => [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [messages])
  useEffect(() => { if (!collapsed) endRef.current?.scrollIntoView({ block: 'end' }) }, [ordered.length, collapsed])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const body = text.trim()
    if (!body) return
    setNotice(null)
    try {
      // A message written here is `manual`. A pasted one is `imported`. Nothing typed or pasted into
      // this composer can reach a terminal; the main process exposes no such path.
      await window.novaCourt.appendCourtMessage({ sender, recipient, text: body, source: mode === 'import' ? 'imported' : 'manual', ...(caseRef.trim() ? { caseRef: caseRef.trim() } : {}) })
      setText('')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function forward(message: CourtMessage) {
    setNotice(null)
    try {
      await window.novaCourt.forwardCourtMessage(message.id, recipient === 'court' ? 'nova' : recipient === sender ? 'nova' : recipient)
      setNotice(`Forwarded to ${recipient === 'court' ? 'Nova' : RECIPIENTS.find((entry) => entry.value === recipient)?.label.replace('Send to ', '') ?? 'Nova'}. The original is unchanged.`)
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function copy(message: CourtMessage) {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(message.id)
      setTimeout(() => setCopied(null), 1600)
    } catch { setNotice('Clipboard access was refused by the system') }
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

  return <section className={`court-thread${collapsed ? ' is-collapsed' : ''}`} aria-label="Shared courtroom conversation" style={collapsed ? undefined : { height }}>
    <div className="court-thread-head">
      <div className="court-thread-title"><Users size={15}/><strong>THE COURT</strong><span className="court-thread-count">{ordered.length} message{ordered.length === 1 ? '' : 's'}</span></div>
      <div className="court-thread-head-right">
        <span className="court-thread-note">Discussion only · sending here never runs a command</span>
        <button className="court-thread-collapse" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand the shared conversation' : 'Collapse the shared conversation'} title={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button>
      </div>
    </div>

    {collapsed ? <div className="court-thread-collapsed-preview">{ordered.length ? <><Avatar participant={ordered[ordered.length - 1]!.sender} size={16}/><span>{ordered[ordered.length - 1]!.text.slice(0, 90)}</span></> : <span>No messages yet.</span>}</div> : <>
      <div className="court-thread-list">
        {ordered.length === 0 ? <div className="court-thread-empty"><Scale size={22}/><h3>The court has not spoken.</h3><p>Send a message below, or import one you copied from Astra’s window or a terminal. Imported messages are labelled and never treated as instructions.</p></div>
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
                  {message.caseRef && <span className="tag tag-case">CASE {message.caseRef}</span>}
                  {message.forwardedFrom && <span className="tag tag-forward"><Forward size={10}/> FORWARDED</span>}
                </div>
                <div className="court-message-actions">
                  <button onClick={() => void copy(message)} aria-label={`Copy ${meta.name}'s message`}>{copied === message.id ? 'Copied' : <><Copy size={12}/> Copy</>}</button>
                  <button onClick={() => void forward(message)} aria-label={`Forward ${meta.name}'s message`}><Forward size={12}/> Forward</button>
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
        <div className="court-composer-hint">This records a discussion message. It does not run commands, start a terminal, or approve any work. <span>·</span> Enter to send, Shift + Enter for a new line</div>
        {notice && <div className="court-thread-notice" role="status">{notice}</div>}
      </form>
    </>}
  </section>
}