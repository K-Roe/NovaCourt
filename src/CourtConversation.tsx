import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, MessageSquare, RotateCcw, Scale, Square, Users, Loader2, CheckCircle, AlertCircle, ShieldAlert } from 'lucide-react'
import Avatar from './Avatar'
import { PARTICIPANT_META } from './portraits'
import type { CourtMessage, CourtParticipant, UnifiedTurn } from './types'

const UNIFIED_STAGE_ORDER = ['karl-recorded', 'astra-submitted', 'astra-responded', 'nova-submitted', 'nova-responded', 'returned-to-karl'] as const

const STAGE_SEAT: Record<string, string> = {
  'astra-submitted': 'Astra',
  'astra-responded': 'Astra',
  'nova-submitted': 'Nova',
  'nova-responded': 'Nova'
}

const SOURCE_LABEL: Record<CourtMessage['source'], string> = {
  manual: 'COMPOSED HERE',
  imported: 'IMPORTED BY HAND',
  connected: 'RECEIVED FROM NOVA'
}

const DELIVERY_LABEL: Record<CourtMessage['delivery'], string> = {
  local: 'LOCAL ONLY',
  'awaiting-send': 'SENDING…',
  sent: 'SENT',
  unconfirmed: 'UNCONFIRMED',
  // Not the same as UNCONFIRMED, and deliberately not FAILED either. This message may well have been
  // accepted by ChatGPT; we simply could not see it in time to prove it. Saying "FAILED" here would
  // invite a resend that duplicates the message.
  'delivery-unknown': 'MAY HAVE ARRIVED',
  'prepared-for-astra': 'PREPARED FOR ASTRA',
  'prepared-for-opencode': 'PREPARED FOR OPENCODE',
  'prepared-for-powershell': 'PREPARED FOR POWERSHELL',
  'awaiting-karl-submission': 'AWAITING KARL',
  'confirmed-delivered': 'CONFIRMED',
  failed: 'FAILED'
}

function time(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

type UnifiedStatus = 
  | { phase: 'ready' }
  | { phase: 'astra-thinking'; detail: string }
  | { phase: 'awaiting-astra'; detail: string }
  | { phase: 'nova-thinking'; detail: string }
  | { phase: 'awaiting-nova'; detail: string }
  | { phase: 'error'; detail: string }
  | { phase: 'uncertain'; detail: string }
  | { phase: 'needs-approval'; detail: string }

export default function CourtConversation({ 
  height, 
  collapsed, 
  maximised, 
  onToggle, 
  onMaximise,
  unifiedStatus
}: { 
  height: number; 
  collapsed: boolean; 
  maximised: boolean; 
  onToggle: () => void; 
  onMaximise: () => void;
  unifiedStatus: UnifiedStatus;
}) {
  const [messages, setMessages] = useState<CourtMessage[]>([])
  const [participantFilter, setParticipantFilter] = useState<'all' | CourtParticipant>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | CourtMessage['source']>('all')
  const endRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [pending, setPending] = useState<{ turnId: string; stage: string; busy: boolean; notice: string | null } | null>(null)
  const [pendingNotice, setPendingNotice] = useState<string | null>(null)

  const recovering = unifiedStatus.phase === 'uncertain' || unifiedStatus.phase === 'needs-approval'

  // The banner exists because a refusal with no button is a dead end. The stage it names is read from
  // the same place the send path reads it, so the warning and the buttons can never disagree.
  useEffect(() => {
    if (!recovering) { setPending(null); return }
    setPendingNotice(null)
    let stale = false
    void window.novaCourt.getUnifiedTurnState().then((state) => {
      if (stale) return
      const active: UnifiedTurn | null = state.active
      const stage = active
        ? UNIFIED_STAGE_ORDER.find((candidate) => {
          const status = active.stages[candidate].status
          return status === 'uncertain' || status === 'awaiting-approval'
        }) ?? null
        : null
      setPending(active && stage ? { turnId: active.id, stage, busy: false, notice: null } : null)
    }).catch(() => {})
    return () => { stale = true }
  }, [recovering])

  async function reconcilePendingTurn() {
    if (!pending || pending.busy) return
    setPending({ ...pending, busy: true, notice: null })
    try {
      const result = await window.novaCourt.reconcileUnifiedTurn(pending.turnId)
      if (result.observation === 'accepted') {
        setPending(null)
        setPendingNotice('Prompt found. The turn continues from where it stopped — nothing was resent.')
      } else if (result.observation === 'absent') {
        setPending(null)
        setPendingNotice('Prompt not found. The turn is marked not sent, so it may be sent again.')
      } else {
        setPending({ ...pending, busy: false, notice: result.reason ?? 'Could not be checked automatically.' })
      }
    } catch (cause) {
      setPending({ ...pending, busy: false, notice: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  async function cancelPendingTurn() {
    if (!pending || pending.busy) return
    setPending({ ...pending, busy: true, notice: null })
    try {
      await window.novaCourt.cancelUnifiedTurn(pending.turnId)
      setPending(null)
      setPendingNotice('Pending turn cancelled. Its record is kept in history; nothing was sent.')
    } catch (cause) {
      setPending({ ...pending, busy: false, notice: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  useEffect(() => {
    void window.novaCourt.getCourtMessages().then(setMessages).catch(() => {})
    return window.novaCourt.onCourtMessages(setMessages)
  }, [])

  const ordered = useMemo(() => [...messages]
    .filter((message) => participantFilter === 'all' || message.sender === participantFilter)
    .filter((message) => sourceFilter === 'all' || message.source === sourceFilter)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [messages, participantFilter, sourceFilter])

  useEffect(() => {
    if (collapsed || !listRef.current) return
    const list = listRef.current
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 50
    if (atBottom && !userScrolledUp) {
      endRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [ordered.length, collapsed, userScrolledUp])

  const handleScroll = () => {
    if (!listRef.current) return
    const list = listRef.current
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 50
    setUserScrolledUp(!atBottom)
  }

  const recipientDisplay = (r: CourtMessage['recipient']) => {
    if (r === 'court') return 'THE WHOLE COURT'
    if (r === 'both') return 'BOTH AGENTS'
    return PARTICIPANT_META[r as CourtParticipant].name.toUpperCase()
  }

  function getStatusBadge() {
    switch (unifiedStatus.phase) {
      case 'ready':
        return (
          <span className="status-badge ready" data-testid="unified-status">
            <CheckCircle size={14} /> Ready for Karl
          </span>
        )
      case 'astra-thinking':
        return (
          <span className="status-badge astra-thinking" data-testid="unified-status">
            <Loader2 size={14} className="spinning" /> Astra is thinking… {unifiedStatus.detail}
          </span>
        )
      case 'awaiting-astra':
        return (
          <span className="status-badge awaiting-astra" data-testid="unified-status">
            <MessageSquare size={14} /> Waiting for Astra… {unifiedStatus.detail}
          </span>
        )
      case 'nova-thinking':
        return (
          <span className="status-badge nova-thinking" data-testid="unified-status">
            <Loader2 size={14} className="spinning" /> Nova is thinking… {unifiedStatus.detail}
          </span>
        )
      case 'awaiting-nova':
        return (
          <span className="status-badge awaiting-nova" data-testid="unified-status">
            <Bot size={14} /> Waiting for Nova… {unifiedStatus.detail}
          </span>
        )
      case 'error':
        return (
          <span className="status-badge error" data-testid="unified-status">
            <AlertCircle size={14} /> Error: {unifiedStatus.detail}
          </span>
        )
      case 'uncertain':
        return (
          <span className="status-badge error" data-testid="unified-status">
            <ShieldAlert size={14} /> Delivery unconfirmed: {unifiedStatus.detail}
          </span>
        )
      case 'needs-approval':
        return (
          <span className="status-badge error" data-testid="unified-status">
            <ShieldAlert size={14} /> Needs your decision: {unifiedStatus.detail}
          </span>
        )
    }
  }

  return (
    <section className={`court-thread${collapsed ? ' is-collapsed' : ''}`} aria-label="Shared courtroom conversation" style={collapsed ? undefined : { height }}>
      <div className="court-thread-head">
        <div className="court-thread-title">
          <Users size={15} />
          <strong>THE COURT</strong>
          <span className="court-thread-count">{ordered.length} of {messages.length}</span>
        </div>
        <div className="court-thread-head-right">
          {getStatusBadge()}
          {!collapsed && <button className="court-thread-maximise" onClick={onMaximise} aria-expanded={maximised} aria-label={maximised ? 'Restore the shared conversation' : 'Maximise the shared conversation'} title={maximised ? 'Restore' : 'Maximise'}>{maximised ? <RotateCcw size={15} /> : <Square size={15} />}</button>}
          <button className="court-thread-collapse" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand the shared conversation' : 'Collapse the shared conversation'} title={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
        </div>
      </div>

      {collapsed ? (
        <div className="court-thread-collapsed-preview">
          {messages.length ? (
            <>
              <Avatar participant={messages[messages.length - 1]!.sender} size={16} />
              <span>{messages[messages.length - 1]!.text.slice(0, 90)}</span>
            </>
          ) : (
            <span>No messages yet.</span>
          )}
        </div>
      ) : (
        <>
          <div className="court-filters">
            <label>FROM
              <select aria-label="Filter by participant" value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value as 'all' | CourtParticipant)}>
                <option value="all">Everyone</option>
                <option value="karl">Karl</option>
                <option value="astra">Astra</option>
                <option value="nova">Nova</option>
              </select>
            </label>
            <label>SOURCE
              <select aria-label="Filter by source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as 'all' | CourtMessage['source'])}>
                <option value="all">Every source</option>
                <option value="manual">Composed here</option>
                <option value="imported">Imported by hand</option>
                <option value="connected">Received from Nova</option>
              </select>
            </label>
      </div>

      {recovering && (pending || pendingNotice) ? <div className="turn-recovery" role="alert" data-testid="turn-recovery">
        <div className="turn-recovery-text">
          <ShieldAlert size={15}/>
          <span>
            {pending
              ? <>A turn is stuck at <strong>{pending.stage}</strong>{STAGE_SEAT[pending.stage] ? ` (${STAGE_SEAT[pending.stage]})` : ''}. We could not confirm that message arrived, so it has <strong>not</strong> been resent. Check the conversation, then reconcile or cancel.</>
              : pendingNotice}
          </span>
        </div>
        {pending && <div className="turn-recovery-actions">
          <button onClick={reconcilePendingTurn} disabled={pending.busy} aria-label="Reconcile the pending turn">{pending.busy ? 'Checking…' : 'Reconcile now'}</button>
          <button className="secondary" onClick={cancelPendingTurn} disabled={pending.busy} aria-label="Cancel pending turn">Cancel pending turn</button>
        </div>}
        {pending?.notice && <p className="turn-recovery-notice">{pending.notice}</p>}
      </div> : null}


          <div className="court-thread-list" ref={listRef} onScroll={handleScroll}>
            {ordered.length === 0 ? (
              <div className="court-thread-empty">
                <Scale size={22} />
                <h3>{messages.length ? 'Nothing matches these filters.' : 'The court has not spoken.'}</h3>
                <p>{messages.length ? 'Change the participant or source filter to see the rest of the record.' : 'Type a message in Karl\'s seat to start the conversation.'}</p>
              </div>
            ) : (
              ordered.map((message) => {
                const meta = PARTICIPANT_META[message.sender]
                return (
                  <article className={`court-message sender-${message.sender} source-${message.source}`} key={message.id} data-testid="court-message" data-source={message.source} data-sender={message.sender}>
                    <Avatar participant={message.sender} size={30} />
                    <div className="court-message-body">
                      <div className="court-message-meta">
                        <strong>{meta.name}</strong>
                        <span className="court-message-role">{meta.role}</span>
                        <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
                      </div>
                      <p className="court-message-text">{message.text}</p>
                      <div className="court-message-tags">
                        <span className={`tag tag-source-${message.source}`}>{SOURCE_LABEL[message.source]}</span>
                        <span className="tag tag-recipient">TO {recipientDisplay(message.recipient)}</span>
                        <span className={`tag tag-delivery-${message.delivery}`}>{DELIVERY_LABEL[message.delivery]}</span>
                        {message.acknowledged && <span className="tag tag-ack">KARL CONFIRMED SENT IN CHATGPT</span>}
                        {message.caseRef && <span className="tag tag-case">CASE {message.caseRef}</span>}
                        {message.forwardedFrom && <span className="tag tag-forward"><RotateCcw size={10} /> FORWARDED</span>}
                      </div>
                    </div>
                  </article>
                )
              })
            )}
            <div ref={endRef} />
          </div>
        </>
      )}
    </section>
  )
}